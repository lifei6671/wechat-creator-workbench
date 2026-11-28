import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "../dist/app.js";
import { openSqlite } from "../dist/adapters/sqlite.js";
import { localFiles } from "../dist/adapters/local-files.js";

const cases = [
  "url_change_between_aliases_preserves_pending_sync",
  "managed_s3_remote_retirement_converges_before_another_device_exports",
  "automatic_private_cleanup_between_devices_restores_an_offline_pending_reference",
  "managed_s3_cleanup_restores_an_inflight_generation_before_external_delivery",
  "image_canvas_projects_renders_and_private_inputs_between_workspaces",
  "multilevel_dependencies_resume_only_after_all_assets_are_repaired",
  "failed_legacy_baseline_refetches_after_versioned_admin_repair",
  "claim_join_and_reconnect_using_real_service",
  "articles_and_private_images_between_workspaces",
  "canvases_between_workspaces",
  "first_join_merges_two_populated_workspaces",
  "blob_group_receipt_survives_response_loss_and_device_reregistration",
  "recover_only_device_into_fresh_workspace",
  "reinstall_with_same_connection_key_restores_and_continues_two_way_sync",
  "initialization_resumes_after_original_repair_and_keeps_other_devices_waiting",
];
const selected = process.argv[2] ? [process.argv[2]] : cases;
if (selected.some(name => !cases.includes(name))) throw new Error("Unknown native acceptance case");
for (const testName of selected) {
  console.log("Native acceptance: " + testName);
  // A fresh service and keyring identities are exclusive to this native acceptance run.
  const directory = await mkdtemp(join(tmpdir(), "wechat-native-sync-"));
  const setup = randomBytes(32).toString("hex");
  const db = openSqlite(join(directory, "sync.db"));
  const app = createApp(db, await localFiles(join(directory, "blobs")), setup);
  const objects=new Map();
  let pauseDelete=false,deleteWaiting=false,releaseDelete,failNextHead=false;
  const fetch = async request => {
    const path=new URL(request.url).pathname;
    if(testName==="automatic_private_cleanup_between_devices_restores_an_offline_pending_reference"&&path==="/__test/gc-due") {
      await db.batch([["UPDATE image_gc_copies SET due_at=0 WHERE state='waiting'"]]);return new Response(null,{status:204});
    }
    if(["managed_s3_cleanup_restores_an_inflight_generation_before_external_delivery","managed_s3_remote_retirement_converges_before_another_device_exports"].includes(testName)) {
      if(path==="/__test/gc-expiry-queue") {
        const [jobs]=await db.batch([["SELECT j.id,c.source_sha256,c.content_sha256,c.created_epoch FROM image_gc_jobs j JOIN image_gc_copies c ON c.id=j.copy_id WHERE c.backend='private' AND j.state='retired' ORDER BY j.created_at,j.id LIMIT 2"]]);
        if(jobs.length!==2) throw Error("Expected two retired private recovery jobs");
        await db.batch([["UPDATE image_gc_jobs SET expires_at=0 WHERE id IN (?,?)",jobs[0].id,jobs[1].id],
          ["INSERT INTO image_gc_copies(id,backend,scope,object_key,generation,source_sha256,content_sha256,size_bytes,managed,state,created_at,created_epoch) VALUES('pending-public','s3','test','pending-key','pending-generation',?,?,10,1,'unknown',0,?)",jobs[0].source_sha256,jobs[0].content_sha256,jobs[0].created_epoch]]);
        return Response.json(jobs.map(job=>job.id));
      }
      if(path==="/__test/gc-expiry-status") {const [jobs]=await db.batch([["SELECT id,state FROM image_gc_jobs ORDER BY created_at,id"]]);return Response.json(jobs);}
      if(path==="/__test/gc-s3-due") {await db.batch([["UPDATE image_gc_copies SET due_at=0 WHERE state='waiting'"]]);return new Response(null,{status:204});}
      if(path==="/__test/gc-s3-fail-next-head") {failNextHead=true;return new Response(null,{status:204});}
      if(path==="/__test/gc-s3-pause") {pauseDelete=true;return new Response(null,{status:204});}
      if(path==="/__test/gc-s3-status") return Response.json({deleteWaiting,objects:objects.size});
      if(path==="/__test/gc-s3-release") {releaseDelete?.();return new Response(null,{status:204});}
      if(path.startsWith("/gc-bucket/")) {
        const key=decodeURIComponent(path.slice("/gc-bucket/".length));
        if(request.method==="PUT") {
          const bytes=Buffer.from(await request.arrayBuffer());
          const headers={"Content-Length":String(bytes.length),ETag:'"'+createHash("sha256").update(bytes).digest("hex")+'"',"Content-Type":request.headers.get("content-type")??"application/octet-stream"};
          for(const [name,value] of request.headers) if(name.startsWith("x-amz-meta-")) headers[name]=value;
          objects.set(key,{bytes,headers});return new Response(null,{status:200,headers:{ETag:headers.ETag}});
        }
        if(request.method==="HEAD"&&failNextHead){failNextHead=false;return new Response(null,{status:503});}
        const object=objects.get(key);
        if(!object) return new Response(request.method==="HEAD"?null:'<Error><Code>NoSuchKey</Code></Error>',{status:404});
        if(request.method==="DELETE") {
          if(request.headers.get("if-match")!==object.headers.ETag) return new Response('<Error><Code>PreconditionFailed</Code></Error>',{status:412});
          if(pauseDelete) {pauseDelete=false;deleteWaiting=true;await new Promise(resolve=>{releaseDelete=resolve;});deleteWaiting=false;}
          objects.delete(key);return new Response(null,{status:204});
        }
        return new Response(request.method==="HEAD"?null:object.bytes,{status:200,headers:object.headers});
      }
    }
    if (testName === "failed_legacy_baseline_refetches_after_versioned_admin_repair"
        && new URL(request.url).pathname === "/__test/legacy-invalid" && request.method === "POST") {
      await db.batch([["UPDATE sync_entities SET payload_json=json_set(payload_json, '$.status', 'inbox') WHERE entity_type='entry' AND entity_id='legacy'"]]);
      return new Response(null, { status: 204 });
    }
    return app.fetch(request);
  };
  const server = serve({ fetch, hostname: "127.0.0.1", port: 0 });
  try {
    if (!server.listening) await once(server, "listening");
    const child = spawn("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "--locked",
      testName, "--", "--ignored", "--nocapture"], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      env: { ...process.env, WCB_SYNC_TEST_URL: `http://127.0.0.1:${server.address().port}/`, WCB_SYNC_TEST_SETUP: setup },
      stdio: ["ignore", "inherit", "inherit"],
    });
    const [code] = await once(child, "exit");
    if (code !== 0) process.exitCode = code ?? 1;
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}
