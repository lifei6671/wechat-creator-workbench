use crate::{
    assets::Assets,
    content::{EntryPatch, Filter, Kind},
    db::{AppError, Result as AppResult, Workspace},
    wechat_import::Imports,
};
use rmcp::{
    ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, ErrorData, Implementation, ProtocolVersion, ServerCapabilities,
        ServerConfig,
    },
    tool, tool_handler, tool_router,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use super::Permission;

#[derive(Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Listing {
    kind: Option<Kind>,
    status: Option<String>,
    category_id: Option<String>,
    tag_ids: Option<Vec<String>>,
    #[serde(default)]
    offset: i64,
}

impl Listing {
    fn filter(self, query: Option<String>) -> Filter {
        Filter {
            kind: self.kind,
            status: self.status,
            category_id: self.category_id,
            tag_ids: self.tag_ids,
            query,
            offset: self.offset,
            ..Filter::default()
        }
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Search {
    query: String,
    #[serde(default)]
    filter: Listing,
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
    tool_router: ToolRouter<Self>,
}

impl Tools {
    pub(super) fn new(
        app: AppHandle,
        permission: Permission,
        cancel: CancellationToken,
        tasks: TaskTracker,
    ) -> Self {
        Self {
            app,
            permission,
            cancel,
            tasks,
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
            self.workspace().entries(input.filter(None))
        })
    }

    #[tool(
        description = "按文字搜索文章、灵感和资料，使用与桌面工作台相同的搜索规则。",
        annotations(read_only_hint = true)
    )]
    fn search_entries(&self, Parameters(input): Parameters<Search>) -> ToolResult {
        self.execute("search_entries", false, || {
            if input.query.trim().is_empty() || input.query.len() > 4096 {
                return Err(AppError::invalid("搜索词须为 1 至 4096 字节"));
            }
            self.workspace()
                .entries(input.filter.filter(Some(input.query)))
        })
    }

    #[tool(
        description = "读取正文、内容属性与当前版本。",
        annotations(read_only_hint = true)
    )]
    fn get_entry(&self, Parameters(input): Parameters<EntryId>) -> ToolResult {
        self.execute("get_entry", false, || self.workspace().get_entry(&input.id))
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
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
