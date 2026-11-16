use super::{Agent, MAX_RESPONSE_BYTES, process_error, response_error};
use crate::db::Result;
use serde_json::{Value, json};
use std::path::Path;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Child,
};

pub(super) const ARGS: &[&str] = &[
    "app-server",
    "--listen",
    "stdio://",
    "--disable",
    "shell_tool",
    "--disable",
    "hooks",
    "--disable",
    "plugins",
    "--disable",
    "apps",
    "--disable",
    "multi_agent",
    "--disable",
    "code_mode",
    "--disable",
    "memories",
    "--disable",
    "image_generation",
    "-c",
    "web_search=\"disabled\"",
    "-c",
    "notify=[]",
    "-c",
    "project_doc_max_bytes=0",
];

pub(super) async fn run(
    child: &mut Child,
    directory: &Path,
    model: Option<&str>,
    prompt: &str,
    on_delta: impl FnMut(String),
) -> Result<String> {
    let writer = child.stdin.take().expect("piped Codex stdin");
    let stdout = child.stdout.take().expect("piped Codex stdout");
    let reader = BufReader::new(stdout.take((MAX_RESPONSE_BYTES + 1) as u64));
    AppServer {
        reader,
        writer,
        line: Vec::new(),
    }
    .turn(directory, model, prompt, on_delta)
    .await
}

struct AppServer<R, W> {
    reader: R,
    writer: W,
    line: Vec<u8>,
}

impl<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin> AppServer<R, W> {
    async fn send(&mut self, message: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&message).map_err(|_| response_error())?;
        bytes.push(b'\n');
        self.writer
            .write_all(&bytes)
            .await
            .map_err(|_| process_error(Agent::Codex))?;
        self.writer
            .flush()
            .await
            .map_err(|_| process_error(Agent::Codex))
    }

    async fn receive(&mut self) -> Result<Value> {
        self.line.clear();
        let count = self
            .reader
            .read_until(b'\n', &mut self.line)
            .await
            .map_err(|_| process_error(Agent::Codex))?;
        if count == 0 {
            return Err(process_error(Agent::Codex));
        }
        if self.line.last() != Some(&b'\n') {
            return Err(response_error());
        }
        let message: Value = serde_json::from_slice(&self.line).map_err(|_| response_error())?;
        if !message["id"].is_null() && !message["method"].is_null() {
            return Err(process_error(Agent::Codex));
        }
        Ok(message)
    }

    async fn call(&mut self, id: u32, method: &str, params: Value) -> Result<Value> {
        self.send(json!({"id": id, "method": method, "params": params}))
            .await?;
        loop {
            let mut message = self.receive().await?;
            if message["id"] == id {
                return message
                    .get_mut("result")
                    .map(Value::take)
                    .ok_or_else(|| process_error(Agent::Codex));
            }
        }
    }

    async fn turn(
        &mut self,
        directory: &Path,
        model: Option<&str>,
        prompt: &str,
        mut on_delta: impl FnMut(String),
    ) -> Result<String> {
        self.call(
            0,
            "initialize",
            json!({"clientInfo": {
                "name": "wechat_creator_workbench",
                "title": "WeChat Creator Workbench",
                "version": env!("CARGO_PKG_VERSION")
            }}),
        )
        .await?;
        self.send(json!({"method": "initialized"})).await?;

        let mut config = self
            .call(
                1,
                "config/read",
                json!({"cwd": directory, "includeLayers": false}),
            )
            .await?;
        // Retain the user's model and login configuration while disabling local tools for this thread.
        let mut servers = config["config"]["mcp_servers"].take();
        if let Some(servers) = servers.as_object_mut() {
            for server in servers.values_mut() {
                let settings = server.as_object_mut().ok_or_else(response_error)?;
                settings.retain(|_, value| !value.is_null());
                settings.insert("enabled".into(), Value::Bool(false));
                settings.insert("required".into(), Value::Bool(false));
            }
        }
        let thread = self
            .call(
                2,
                "thread/start",
                json!({
                    "cwd": directory, "model": model, "ephemeral": true,
                    "approvalPolicy": "never", "sandbox": "read-only",
                    "developerInstructions": "",
                    "config": if servers.is_null() { json!({}) } else { json!({"mcp_servers": servers}) }
                }),
            )
            .await?;
        let thread_id = thread["thread"]["id"].as_str().ok_or_else(response_error)?;
        self.send(json!({
            "id": 3, "method": "turn/start", "params": {
                "threadId": thread_id,
                "input": [{"type": "text", "text": prompt, "text_elements": []}]
            }
        }))
        .await?;

        let mut commentary_item = None;
        let mut reply = None;
        loop {
            let event = self.receive().await?;
            if event["id"] == 3 && event["result"].is_null() {
                return Err(process_error(Agent::Codex));
            }
            let params = &event["params"];
            if params["threadId"] != thread_id {
                continue;
            }
            let item = &params["item"];
            match event["method"].as_str() {
                Some("item/started") if item["type"] == "agentMessage" => {
                    commentary_item = if item["phase"] == "commentary" {
                        item["id"].as_str().map(str::to_owned)
                    } else {
                        None
                    };
                }
                Some("item/agentMessage/delta")
                    if params["itemId"].as_str() != commentary_item.as_deref() =>
                {
                    if let Some(text) = params["delta"].as_str().filter(|text| !text.is_empty()) {
                        on_delta(text.to_owned());
                    }
                }
                Some("item/completed")
                    if item["type"] == "agentMessage" && item["phase"] != "commentary" =>
                {
                    reply = item["text"].as_str().map(str::to_owned);
                }
                Some("turn/completed") => {
                    if params["turn"]["status"] != "completed" {
                        return Err(process_error(Agent::Codex));
                    }
                    return reply.ok_or_else(response_error);
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, split};
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn streams_reply_before_turn_completion() {
        let (client_pipe, server_pipe) = duplex(4096);
        let (reader, writer) = split(client_pipe);
        let mut client = AppServer {
            reader: BufReader::new(reader),
            writer,
            line: Vec::new(),
        };
        let (reader, writer) = split(server_pipe);
        let mut server = AppServer {
            reader: BufReader::new(reader),
            writer,
            line: Vec::new(),
        };
        let (send_delta, receive_delta) = oneshot::channel();
        let model = async {
            let mut request = String::new();
            server.reader.read_line(&mut request).await.unwrap();
            assert!(request.contains("\"method\":\"initialize\""));
            server.send(json!({"id": 0, "result": {}})).await.unwrap();
            request.clear();
            server.reader.read_line(&mut request).await.unwrap();
            assert!(request.contains("\"method\":\"initialized\""));
            request.clear();
            server.reader.read_line(&mut request).await.unwrap();
            assert!(request.contains("\"method\":\"config/read\""));
            server.send(json!({"id": 1, "result": {"config": {"mcp_servers": {
                "local": {"command": "example", "enabled": true, "required": true, "tool_timeout_sec": null}
            }}}})).await.unwrap();
            request.clear();
            server.reader.read_line(&mut request).await.unwrap();
            let start: Value = serde_json::from_str(&request).unwrap();
            assert_eq!(start["method"], "thread/start");
            assert_eq!(start["params"]["approvalPolicy"], "never");
            assert_eq!(start["params"]["sandbox"], "read-only");
            assert_eq!(start["params"]["ephemeral"], true);
            assert_eq!(start["params"]["developerInstructions"], "");
            assert_eq!(start["params"]["model"], "test-model");
            assert_eq!(
                start["params"]["config"]["mcp_servers"]["local"],
                json!({"command": "example", "enabled": false, "required": false}),
            );
            server
                .send(json!({"id": 2, "result": {"thread": {"id": "test"}}}))
                .await
                .unwrap();
            request.clear();
            server.reader.read_line(&mut request).await.unwrap();
            let start: Value = serde_json::from_str(&request).unwrap();
            assert_eq!(start["method"], "turn/start");
            assert_eq!(start["params"]["input"][0]["text"], "测试问题");

            for line in [
                r#"{"id":3,"result":{"turn":{"id":"turn"}}}"#,
                r#"{"method":"item/started","params":{"threadId":"test","item":{"type":"agentMessage","id":"aside","phase":"commentary"}}}"#,
                r#"{"method":"item/agentMessage/delta","params":{"threadId":"test","itemId":"aside","delta":"进度"}}"#,
                r#"{"method":"item/agentMessage/delta","params":{"threadId":"other","itemId":"answer","delta":"另一会话"}}"#,
                r#"{"method":"item/agentMessage/delta","params":{"threadId":"test","itemId":"answer","delta":"你好"}}"#,
            ] {
                server.writer.write_all(line.as_bytes()).await.unwrap();
                server.writer.write_all(b"\n").await.unwrap();
            }
            assert_eq!(receive_delta.await.unwrap(), "你好");
            for line in [
                r#"{"method":"item/agentMessage/delta","params":{"threadId":"test","itemId":"answer","delta":"，世界"}}"#,
                r#"{"method":"item/completed","params":{"threadId":"test","item":{"type":"agentMessage","text":"你好，世界","phase":"final_answer"}}}"#,
                r#"{"method":"turn/completed","params":{"threadId":"test","turn":{"status":"completed"}}}"#,
            ] {
                server.writer.write_all(line.as_bytes()).await.unwrap();
                server.writer.write_all(b"\n").await.unwrap();
            }
        };
        let mut first_delta = Some(send_delta);
        let mut deltas = Vec::new();
        let (reply, ()) = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            tokio::join!(
                client.turn(Path::new("."), Some("test-model"), "测试问题", |text| {
                    if let Some(sender) = first_delta.take() {
                        sender.send(text.clone()).unwrap();
                    }
                    deltas.push(text);
                }),
                model
            )
        })
        .await
        .unwrap();
        assert_eq!(deltas, ["你好", "，世界"]);
        assert_eq!(reply.unwrap(), "你好，世界");
    }

    #[tokio::test]
    async fn failed_turn_never_returns_partial_reply() {
        let output = concat!(
            "{\"id\":0,\"result\":{}}\n",
            "{\"id\":1,\"result\":{\"config\":{}}}\n",
            "{\"id\":2,\"result\":{\"thread\":{\"id\":\"test\"}}}\n",
            "{\"id\":3,\"result\":{}}\n",
            "{\"method\":\"item/completed\",\"params\":{\"threadId\":\"test\",\"item\":{\"type\":\"agentMessage\",\"text\":\"partial\"}}}\n",
            "{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"test\",\"turn\":{\"status\":\"failed\",\"error\":{\"message\":\"private\"}}}}\n"
        );
        let error = AppServer {
            reader: output.as_bytes(),
            writer: tokio::io::sink(),
            line: Vec::new(),
        }
        .turn(Path::new("."), None, "test", |_| {})
        .await
        .unwrap_err();
        assert_eq!(error.code(), "AI_AGENT");
        assert!(!error.to_string().contains("private"));
    }
}
