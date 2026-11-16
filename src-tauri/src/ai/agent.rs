use super::{MAX_RESPONSE_BYTES, response_error, settings::Agent};
use crate::db::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, env, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::timeout,
};

const AGENT_TIMEOUT: Duration = Duration::from_secs(120);

pub fn executable(agent: Agent) -> Option<PathBuf> {
    let path = env::var_os("PATH").unwrap_or_default();
    let mut directories: Vec<_> = env::split_paths(&path).collect();
    if let Some(home) = env::home_dir() {
        directories.push(home.join(".local").join("bin"));
    }
    #[cfg(target_os = "macos")]
    directories.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));

    directories
        .into_iter()
        .filter(|path| path.is_absolute())
        .find_map(|dir| {
            let path = dir.join(format!("{}{}", agent.executable(), env::consts::EXE_SUFFIX));
            if path.is_file() {
                #[cfg(target_os = "macos")]
                if agent == Agent::Codex {
                    let actual = path.canonicalize().ok()?;
                    if actual.file_name()?.to_str()? == "codex.js" {
                        return npm_codex(actual.parent()?.parent()?);
                    }
                }
                return Some(path);
            }
            #[cfg(windows)]
            return match agent {
                Agent::Codex => npm_codex(&dir.join("node_modules/@openai/codex")),
                Agent::ClaudeCode => {
                    let binary = dir.join("node_modules/@anthropic-ai/claude-code/bin/claude.exe");
                    binary.is_file().then_some(binary)
                }
            };
            #[cfg(not(windows))]
            {
                None
            }
        })
}

#[cfg(any(windows, target_os = "macos"))]
fn npm_codex(package: &std::path::Path) -> Option<PathBuf> {
    // Run the native process directly so cancellation cannot leave it behind an npm shim.
    let arch = env::consts::ARCH;
    let npm_arch = match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return None,
    };
    #[cfg(windows)]
    let (platform, triple) = ("win32", "pc-windows-msvc");
    #[cfg(target_os = "macos")]
    let (platform, triple) = ("darwin", "apple-darwin");
    let platform_package = format!("@openai/codex-{platform}-{npm_arch}");
    let binary = format!(
        "vendor/{arch}-{triple}/bin/codex{}",
        env::consts::EXE_SUFFIX
    );
    [
        package.join("node_modules").join(&platform_package),
        package.parent()?.parent()?.join(&platform_package),
        package.to_owned(),
    ]
    .into_iter()
    .map(|root| root.join(&binary))
    .find(|path| path.is_file())
}

fn arguments(agent: Agent) -> &'static [&'static str] {
    match agent {
        Agent::Codex => &[
            "exec",
            "--skip-git-repo-check",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--sandbox",
            "read-only",
            "-c",
            "approval_policy=\"never\"",
            "-c",
            "web_search=\"disabled\"",
            "--disable",
            "shell_tool",
            "--disable",
            "hooks",
            "--disable",
            "plugins",
            "--json",
        ],
        Agent::ClaudeCode => &[
            "--print",
            "--output-format",
            "json",
            "--no-session-persistence",
            "--setting-sources",
            "",
            "--tools",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            r#"{"mcpServers":{}}"#,
            "--disable-slash-commands",
        ],
    }
}

#[derive(Serialize)]
pub struct ModelOption {
    id: String,
    label: String,
}

fn parse_catalog(data: &[u8]) -> serde_json::Result<Vec<ModelOption>> {
    #[derive(Deserialize)]
    struct Catalog {
        models: Vec<Entry>,
    }
    #[derive(Deserialize)]
    struct Entry {
        slug: String,
        display_name: String,
        visibility: String,
    }
    let mut seen = HashSet::new();
    Ok(serde_json::from_slice::<Catalog>(data)?
        .models
        .into_iter()
        .filter(|entry| {
            entry.visibility == "list"
                && valid_model_id(&entry.slug)
                && !entry.display_name.trim().is_empty()
                && seen.insert(entry.slug.clone())
        })
        .map(|entry| ModelOption {
            id: entry.slug,
            label: entry.display_name,
        })
        .collect())
}

pub fn valid_model_id(id: &str) -> bool {
    id.len() <= 128
        && id.starts_with(|ch: char| ch.is_ascii_alphanumeric())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._:/".contains(&byte))
}

async fn codex_catalog() -> Option<Vec<ModelOption>> {
    let mut command = Command::new(executable(Agent::Codex)?);
    command
        .args(["debug", "models", "--bundled"])
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().ok()?;
    timeout(Duration::from_secs(6), async {
        let mut data = Vec::new();
        child
            .stdout
            .take()?
            .take((MAX_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut data)
            .await
            .ok()?;
        if data.len() > MAX_RESPONSE_BYTES || !child.wait().await.ok()?.success() {
            return None;
        }
        parse_catalog(&data).ok()
    })
    .await
    .ok()?
}

pub async fn model_catalog() -> [(Agent, Vec<ModelOption>); 2] {
    let claude = [("sonnet", "Sonnet"), ("opus", "Opus"), ("haiku", "Haiku")]
        .into_iter()
        .map(|(id, label)| ModelOption {
            id: id.into(),
            label: label.into(),
        })
        .collect();
    [
        (Agent::Codex, codex_catalog().await.unwrap_or_default()),
        (Agent::ClaudeCode, claude),
    ]
}

fn process_error(agent: Agent) -> AppError {
    AppError::new(
        "AI_AGENT",
        format!(
            "{} 未能完成请求，请在终端检查登录状态和 CLI 版本",
            agent.label()
        ),
    )
}

pub async fn version(agent: Agent) -> Option<String> {
    let mut command = Command::new(executable(agent)?);
    command
        .arg("--version")
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = timeout(Duration::from_secs(4), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = std::str::from_utf8(&output.stdout).ok()?;
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

fn result_text(agent: Agent, output: &[u8]) -> Result<String> {
    match agent {
        Agent::Codex => {
            let mut reply = None;
            let mut completed = false;
            for line in output
                .split(|&byte| byte == b'\n')
                .filter(|line| !line.is_empty())
            {
                let event: serde_json::Value =
                    serde_json::from_slice(line).map_err(|_| response_error())?;
                match event["type"].as_str() {
                    Some("turn.failed") => return Err(process_error(agent)),
                    Some("item.completed") if event["item"]["type"] == "agent_message" => {
                        reply = event["item"]["text"].as_str().map(str::to_owned);
                    }
                    Some("turn.completed") => completed = true,
                    _ => {}
                }
            }
            if !completed {
                return Err(process_error(agent));
            }
            reply.ok_or_else(response_error)
        }
        Agent::ClaudeCode => {
            #[derive(Deserialize)]
            struct Reply {
                result: Option<String>,
                is_error: bool,
            }
            let reply: Reply = serde_json::from_slice(output).map_err(|_| response_error())?;
            if reply.is_error {
                return Err(process_error(agent));
            }
            reply.result.ok_or_else(response_error)
        }
    }
}

pub async fn run(agent: Agent, model: Option<&str>, prompt: &str) -> Result<String> {
    let executable = executable(agent).ok_or_else(|| {
        AppError::new(
            "AI_AGENT_MISSING",
            format!("未找到 {}，请安装并重启工作台", agent.label()),
        )
    })?;
    let directory = tempfile::tempdir().map_err(|_| process_error(agent))?;
    let mut command = Command::new(executable);
    command.args(arguments(agent)).current_dir(directory.path());
    if let Some(model) = model {
        command.arg(format!("--model={model}"));
    }
    if agent == Agent::Codex {
        command.arg("-");
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = timeout(AGENT_TIMEOUT, async {
        let mut child = command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| process_error(agent))?;
        let mut stdin = child.stdin.take().expect("piped agent stdin");
        let mut stdout = child
            .stdout
            .take()
            .expect("piped agent stdout")
            .take((MAX_RESPONSE_BYTES + 1) as u64);
        let mut output = Vec::new();
        let (written, read) = tokio::join!(
            async move { stdin.write_all(prompt.as_bytes()).await },
            stdout.read_to_end(&mut output),
        );
        if output.len() > MAX_RESPONSE_BYTES {
            return Err(response_error());
        }
        let status = child.wait().await.map_err(|_| process_error(agent))?;
        if !status.success() || written.is_err() || read.is_err() {
            return Err(process_error(agent));
        }
        Ok(output)
    })
    .await
    .map_err(|_| AppError::new("AI_TIMEOUT", "本地代理请求超时"))??;
    result_text(agent, &output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_lists_visible_unique_models_with_valid_ids() {
        let data = br#"{"models":[
          {"slug":"gpt-6.1-sol","display_name":"GPT-6.1-Sol","visibility":"list"},
          {"slug":"gpt-6.1-sol","display_name":"Duplicate","visibility":"list"},
          {"slug":"gpt-hidden","display_name":"Hidden","visibility":"hide"},
          {"slug":"--disable","display_name":"Invalid","visibility":"list"},
          {"slug":"blank","display_name":" ","visibility":"list"}
        ]}"#;
        let options = parse_catalog(data).unwrap();
        assert_eq!(options.len(), 1);
        assert_eq!(options[0].id, "gpt-6.1-sol");
        assert_eq!(options[0].label, "GPT-6.1-Sol");
    }

    #[test]
    fn reads_only_final_codex_reply_from_a_completed_turn() {
        let output = br#"{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}
{"type":"item.completed","item":{"type":"agent_message","text":"first"}}
{"type":"item.completed","item":{"type":"agent_message","text":"final"}}
{"type":"turn.completed"}
"#;
        assert_eq!(result_text(Agent::Codex, output).unwrap(), "final");
        assert!(
            result_text(
                Agent::Codex,
                br#"{"type":"turn.failed","error":{"message":"private"}}"#
            )
            .is_err()
        );
    }

    #[test]
    fn claude_errors_do_not_expose_the_raw_response() {
        assert_eq!(
            result_text(Agent::ClaudeCode, br#"{"result":"final","is_error":false}"#).unwrap(),
            "final"
        );
        let failure = result_text(
            Agent::ClaudeCode,
            br#"{"result":"private","is_error":true}"#,
        )
        .unwrap_err();
        assert_eq!(failure.code(), "AI_AGENT");
        assert!(!failure.to_string().contains("private"));
    }
}
