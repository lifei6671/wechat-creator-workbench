use crate::{
    assets::Assets,
    content::{EntryPatch, EntrySort, Filter, Kind, MatchPage, WorkspaceSearch},
    db::{AppError, Result as AppResult, Workspace},
    wechat_import::Imports,
};
use rmcp::{
    RoleServer, ServerHandler,
    handler::server::{router::tool::ToolRouter, tool::ToolCallContext, wrapper::Parameters},
    model::{
        CacheScope, CallToolRequestParams, CallToolResponse, CallToolResult, ErrorData,
        Implementation, ListToolsResult, PaginatedRequestParams, ProtocolVersion,
        ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
    tool, tool_handler, tool_router,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    num::NonZeroU32,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use super::{ClientRead, Permission};

#[derive(Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Listing {
    kind: Option<Kind>,
    status: Option<String>,
    category_id: Option<String>,
    tag_ids: Option<Vec<String>>,
    #[serde(default)]
    offset: i64,
    /// 每页条目数，1 至 60。
    #[schemars(range(max = 60))]
    limit: Option<NonZeroU32>,
}

impl Listing {
    fn filter(self) -> AppResult<Filter> {
        if self.limit.is_some_and(|limit| limit.get() > 60) {
            return Err(AppError::invalid("每页最多返回 60 条内容"));
        }
        Ok(Filter {
            kind: self.kind,
            status: self.status,
            category_id: self.category_id,
            tag_ids: self.tag_ids,
            limit: self.limit,
            offset: self.offset,
            ..Filter::default()
        })
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Search {
    query: String,
    /// keyword 按原有关键词匹配，workspace 使用桌面搜索语法并返回带行号、版本的命中片段。
    #[serde(default)]
    mode: SearchMode,
    /// workspace 模式下继续读取一篇条目的匹配行，offset 使用 searchMatches.nextOffset。
    match_page: Option<MatchPage>,
    #[serde(default)]
    filter: Listing,
}

#[derive(Default, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum SearchMode {
    #[default]
    Keyword,
    Workspace,
}

impl Search {
    fn into_filter(self) -> AppResult<Filter> {
        if self.query.trim().is_empty() || self.query.len() > 4096 {
            return Err(AppError::invalid("搜索词须为 1 至 4096 字节"));
        }
        let mut filter = self.filter.filter()?;
        match self.mode {
            SearchMode::Keyword => {
                if self.match_page.is_some() {
                    return Err(AppError::invalid("读取匹配行需要 workspace 搜索模式"));
                }
                filter.query = Some(self.query);
            }
            SearchMode::Workspace => {
                filter.sort = Some(EntrySort::Relevance);
                filter.compact_matches = true;
                if self.match_page.is_some() {
                    filter.offset = 0;
                }
                filter.workspace_search = Some(WorkspaceSearch {
                    text: self.query,
                    case_sensitive: false,
                    match_page: self.match_page,
                });
            }
        }
        Ok(filter)
    }
}

#[derive(Deserialize, JsonSchema)]
struct EntryId {
    id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    kind: Kind,
    title: Option<String>,
    content_md: Option<String>,
    category_id: Option<String>,
    tags: Option<Vec<String>>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    id: String,
    expected_version: i64,
    patch: EntryPatch,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Categories {
    parent_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct Tags {
    query: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct Import {
    url: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Job {
    job_id: String,
}

type ToolResult = std::result::Result<CallToolResult, ErrorData>;

#[derive(Clone)]
pub(super) struct Tools {
    app: AppHandle,
    permission: Permission,
    cancel: CancellationToken,
    tasks: TaskTracker,
    last_read: Arc<Mutex<Option<ClientRead>>>,
    tool_router: ToolRouter<Self>,
}

impl Tools {
    pub(super) fn new(
        app: AppHandle,
        permission: Permission,
        cancel: CancellationToken,
        tasks: TaskTracker,
        last_read: Arc<Mutex<Option<ClientRead>>>,
    ) -> Self {
        Self {
            app,
            permission,
            cancel,
            tasks,
            last_read,
            tool_router: Self::tool_router(),
        }
    }

    fn workspace(&self) -> tauri::State<'_, Workspace> {
        self.app.state()
    }

    fn execute<T: Serialize>(
        &self,
        name: &'static str,
        writes: bool,
        action: impl FnOnce() -> AppResult<T>,
    ) -> ToolResult {
        let _task = self.tasks.token();
        let outcome = authorize(self.permission, writes, &self.cancel).and_then(|()| action());
        let status = outcome.as_ref().map_or_else(AppError::code, |_| "OK");
        eprintln!("MCP {name} {status}");
        if status == "OK" && writes {
            let _ = self.app.emit("workspace-changed", ());
        }
        tool_result(outcome)
    }
}

fn authorize(permission: Permission, writes: bool, cancel: &CancellationToken) -> AppResult<()> {
    if cancel.is_cancelled() {
        return Err(AppError::new("MCP_STOPPED", "MCP 服务正在停止"));
    }
    if writes && permission == Permission::Read {
        return Err(AppError::new("MCP_READ_ONLY", "当前令牌只有读取权限"));
    }
    Ok(())
}

fn tool_result<T: Serialize>(outcome: AppResult<T>) -> ToolResult {
    let result = match outcome {
        Ok(value) => serde_json::to_value(value).map(CallToolResult::structured),
        Err(error) => serde_json::to_value(error).map(CallToolResult::structured_error),
    };
    result.map_err(|_| ErrorData::internal_error("无法编码操作结果", None))
}

#[tool_router]
impl Tools {
    #[tool(
        description = "列出工作区内容，支持分类、标签、类型、状态和分页。",
        annotations(read_only_hint = true)
    )]
    fn list_entries(&self, Parameters(input): Parameters<Listing>) -> ToolResult {
        self.execute("list_entries", false, || {
            self.workspace().entries(input.filter()?)
        })
    }

    #[tool(
        description = "搜索文章、灵感和资料。需要原文依据时使用 mode=workspace，支持 path:、tag:、section: 等桌面语法，返回 searchMatches 和匹配行。省略 mode 时按原有关键词匹配。",
        annotations(read_only_hint = true)
    )]
    fn search_entries(&self, Parameters(input): Parameters<Search>) -> ToolResult {
        self.execute("search_entries", false, || {
            self.workspace().entries(input.into_filter()?)
        })
    }

    #[tool(
        description = "读取正文、内容属性与当前版本。",
        annotations(read_only_hint = true)
    )]
    fn get_entry(&self, Parameters(input): Parameters<EntryId>) -> ToolResult {
        self.execute("get_entry", false, || {
            self.workspace().get_entry(&input.id)?.with_github_images()
        })
    }

    #[tool(
        description = "新建文章草稿、灵感或资料。需要写入权限。",
        annotations(destructive_hint = false)
    )]
    fn create_entry(&self, Parameters(input): Parameters<Create>) -> ToolResult {
        self.execute("create_entry", true, || {
            let fields = EntryPatch {
                title: input.title,
                content_md: input.content_md,
                category_id: input.category_id.map(Some),
                tags: input.tags,
                ..EntryPatch::default()
            };
            self.workspace().create_external(input.kind, fields)
        })
    }

    #[tool(
        description = "以 expectedVersion 修改指定字段。版本冲突返回 VERSION_CONFLICT 与 currentVersion。需要写入权限。"
    )]
    fn update_entry(&self, Parameters(input): Parameters<Update>) -> ToolResult {
        self.execute("update_entry", true, || {
            self.workspace()
                .update_external(&input.id, input.expected_version, input.patch)
        })
    }

    #[tool(
        description = "列出分类树。指定 parentId 时只返回直接子分类。",
        annotations(read_only_hint = true)
    )]
    fn list_categories(&self, Parameters(input): Parameters<Categories>) -> ToolResult {
        self.execute("list_categories", false, || {
            let mut categories = self.workspace().library()?.categories;
            if let Some(parent) = input.parent_id {
                categories.retain(|category| category.parent_id.as_deref() == Some(&parent));
            }
            Ok(serde_json::json!({"items": categories}))
        })
    }

    #[tool(
        description = "列出标签，可按名称筛选。",
        annotations(read_only_hint = true)
    )]
    fn list_tags(&self, Parameters(input): Parameters<Tags>) -> ToolResult {
        self.execute("list_tags", false, || {
            let mut tags = self.workspace().library()?.tags;
            if let Some(query) = input.query {
                let query = query.trim().to_lowercase();
                tags.retain(|tag| tag.name.to_lowercase().contains(&query));
            }
            Ok(serde_json::json!({"items": tags}))
        })
    }

    #[tool(
        description = "为公开公众号链接创建导入任务，返回任务 ID。需要写入权限。",
        annotations(destructive_hint = false, open_world_hint = true)
    )]
    fn import_wechat_article(&self, Parameters(input): Parameters<Import>) -> ToolResult {
        self.execute("import_wechat_article", true, || {
            let (job, start) = self
                .app
                .state::<Imports>()
                .enqueue(&self.workspace(), &input.url)?;
            if start {
                let app = self.app.clone();
                let cancel = self.cancel.clone();
                let id = job.id.clone();
                self.tasks.spawn(async move {
                    if let Err(error) = app
                        .state::<Imports>()
                        .run_queued(
                            &app.state::<Workspace>(),
                            &app.state::<Assets>(),
                            &id,
                            &cancel,
                        )
                        .await
                    {
                        eprintln!("MCP import_wechat_article {}", error.code());
                    }
                    let _ = app.emit("workspace-changed", ());
                    let _ = app.emit("assets-changed", ());
                });
            }
            Ok(job)
        })
    }

    #[tool(
        description = "按任务 ID 查询公众号导入状态、条目和未完成图片数。",
        annotations(read_only_hint = true)
    )]
    fn get_job_status(&self, Parameters(input): Parameters<Job>) -> ToolResult {
        self.execute("get_job_status", false, || {
            self.app
                .state::<Imports>()
                .job(&self.workspace(), &input.job_id)
        })
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for Tools {
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let mut tools = self.tool_router.list_all();
        if self.permission == Permission::Read {
            tools.retain(is_read_tool);
        }
        let mut result = ListToolsResult::with_all_items(tools);
        if context
            .protocol_version()
            .is_some_and(|version| version >= ProtocolVersion::V_2026_07_28)
        {
            result = result.with_ttl_ms(0).with_cache_scope(CacheScope::Private);
        }
        Ok(result)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let read = self
            .tool_router
            .get(&request.name)
            .is_some_and(is_read_tool);
        let client = context.client_info();
        let response = self
            .tool_router
            .call(ToolCallContext::new(self, request, context))
            .await?;
        if read
            && matches!(&response, CallToolResponse::Complete(result) if result.is_error != Some(true))
        {
            let client = client.map_or_else(|| "MCP 客户端".to_owned(), |info| info.name);
            *self.last_read.lock().expect("MCP read status poisoned") = Some(ClientRead {
                client,
                at: crate::db::now(),
            });
            let _ = self.app.emit_to("main", "mcp-status-changed", ());
        }
        Ok(response)
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(&[
            ProtocolVersion::V_2025_03_26,
            ProtocolVersion::V_2025_06_18,
            ProtocolVersion::V_2025_11_25,
            ProtocolVersion::V_2026_07_28,
        ])
    }

    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
            Implementation::new("wechat-creator-workbench", env!("CARGO_PKG_VERSION")),
        ).with_instructions(match self.permission {
            Permission::Read => "当前工作区只读。用 list_entries 浏览文章、灵感和资料，search_entries 的 workspace 模式可返回原文命中，再用 get_entry 读取正文。",
            Permission::Write => "当前工作区可读写。用 list_entries 浏览内容，search_entries 的 workspace 模式可返回原文命中。修改前调用 get_entry 读取版本，用 expectedVersion 保存。遇到 VERSION_CONFLICT 时重读再修改。",
        })
    }
}

fn is_read_tool(tool: &Tool) -> bool {
    tool.annotations
        .as_ref()
        .and_then(|annotations| annotations.read_only_hint)
        == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_preserves_keywords_and_pages_workspace_evidence() {
        let db = Workspace::open(std::path::Path::new(":memory:")).unwrap();
        let text = format!("{}\n{}", "needle ".repeat(100), "needle\n".repeat(13));
        let entry = db
            .create_external(
                Kind::Reference,
                EntryPatch {
                    content_md: Some(text),
                    ..EntryPatch::default()
                },
            )
            .unwrap();
        let search = |input| {
            let params: Search = serde_json::from_value(input).unwrap();
            serde_json::to_value(db.entries(params.into_filter().unwrap()).unwrap()).unwrap()
        };
        let keyword = search(serde_json::json!({"query":"needle"}));
        assert!(keyword["items"][0].get("searchMatches").is_none());
        assert_eq!(
            search(serde_json::json!({"query":"line:needle"}))["items"],
            serde_json::json!([])
        );
        let first = search(
            serde_json::json!({"mode":"workspace","query":"line:needle","filter":{"limit":1}}),
        );
        let matches = &first["items"][0]["searchMatches"];
        assert_eq!(
            matches["version"],
            serde_json::to_value(&entry).unwrap()["version"]
        );
        assert_eq!(matches["items"][0]["line"], 1);
        assert!(matches["items"][0].get("expanded").is_none());
        assert!(
            matches["items"][0]["text"]
                .as_str()
                .unwrap()
                .contains("needle")
        );
        let next = search(serde_json::json!({"mode":"workspace","query":"line:needle",
            "matchPage":{"entryId":first["items"][0]["id"],"offset":matches["nextOffset"]}}));
        assert_eq!(next["items"][0]["searchMatches"]["items"][0]["line"], 13);
        assert!(next["items"][0]["searchMatches"]["nextOffset"].is_null());
        let too_many: Listing = serde_json::from_value(serde_json::json!({"limit":61})).unwrap();
        assert!(too_many.filter().is_err());
    }

    #[test]
    fn scope_and_version_conflict_are_visible_to_clients() {
        let cancel = CancellationToken::new();
        assert!(authorize(Permission::Read, false, &cancel).is_ok());
        let denied = authorize(Permission::Read, true, &cancel).unwrap_err();
        assert_eq!(denied.code(), "MCP_READ_ONLY");
        assert!(authorize(Permission::Write, true, &cancel).is_ok());
        cancel.cancel();
        assert_eq!(
            authorize(Permission::Write, true, &cancel)
                .unwrap_err()
                .code(),
            "MCP_STOPPED"
        );
        let result = tool_result::<()>(Err(AppError::conflict(7))).unwrap();
        assert_eq!(result.is_error, Some(true));
        let data = result.structured_content.unwrap();
        assert_eq!(data["code"], "VERSION_CONFLICT");
        assert_eq!(data["currentVersion"], 7);
    }
}
