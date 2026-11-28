use crate::{
    assets::{self, Assets},
    content::{self, SaveMode},
    db::{AppError, Result, Workspace, now},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use tauri::{
    Emitter, State,
    ipc::{InvokeBody, Request, Response},
};

const MAX_SCENE: usize = 384 * 1024;
const RENDERER: &str = "konva-2";

fn invalid() -> AppError {
    AppError::invalid("图片工程内容无效")
}
fn encode(value: &Value) -> Result<String> {
    serde_json::to_string(value).map_err(|_| invalid())
}
fn parse(raw: String) -> Result<Value> {
    serde_json::from_str(&raw).map_err(|_| invalid())
}
fn scene_hash(scene: &Value) -> Result<String> {
    let bytes = serde_json_canonicalizer::to_vec(scene).map_err(|_| invalid())?;
    Ok(hex::encode(Sha256::digest(bytes)))
}
fn number(value: &Value, min: f64, max: f64) -> Result<f64> {
    value
        .as_f64()
        .filter(|v| v.is_finite() && *v >= min && *v <= max)
        .ok_or_else(invalid)
}
fn color(value: &Value) -> Result<()> {
    let s = value.as_str().ok_or_else(invalid)?;
    if !s.starts_with('#')
        || !matches!(s.len(), 4 | 5 | 7 | 9)
        || !s[1..].bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err(invalid());
    }
    Ok(())
}
fn object(value: &Value, keys: &[&str]) -> Result<()> {
    let map = value.as_object().ok_or_else(invalid)?;
    if map.len() != keys.len() || keys.iter().any(|key| !map.contains_key(*key)) {
        return Err(invalid());
    }
    Ok(())
}
fn dimensions(value: &Value) -> Result<(u32, u32)> {
    let w = value["width"]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(invalid)?;
    let h = value["height"]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(invalid)?;
    assets::validate_dimensions(w, h)?;
    Ok((w, h))
}
fn asset_id(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|s| crate::sync::valid_id(s))
        .ok_or_else(invalid)
}

pub(crate) fn scene_assets(scene: &Value) -> Result<BTreeSet<String>> {
    if encode(scene)?.len() > MAX_SCENE {
        return Err(AppError::invalid("图片工程不能超过 384 KiB"));
    }
    object(scene, &["schemaVersion", "artboard", "layers", "layout"])?;
    if scene["schemaVersion"] != 1 {
        return Err(invalid());
    }
    if let Some(radius) = scene["artboard"].get("cornerRadius") {
        object(&scene["artboard"], &["width", "height", "background", "cornerRadius"])?;
        number(radius, 0., 8000.)?;
    } else {
        object(&scene["artboard"], &["width", "height", "background"])?;
    }
    dimensions(&scene["artboard"])?;
    let mut ids = BTreeSet::new();
    let bg = &scene["artboard"]["background"];
    match bg["type"].as_str() {
        Some("transparent") => object(bg, &["type"])?,
        Some("solid") => {
            object(bg, &["type", "color"])?;
            color(&bg["color"])?;
        }
        Some("image") => {
            object(bg, &["type", "assetId", "fit"])?;
            ids.insert(asset_id(&bg["assetId"])?.into());
            if !matches!(bg["fit"].as_str(), Some("cover" | "contain")) {
                return Err(invalid());
            }
        }
        Some("linear-gradient") => {
            object(bg, &["type", "angle", "stops"])?;
            number(&bg["angle"], -3600., 3600.)?;
            let stops = bg["stops"]
                .as_array()
                .filter(|s| (2..=16).contains(&s.len()))
                .ok_or_else(invalid)?;
            let mut previous = 0.;
            for stop in stops {
                object(stop, &["offset", "color"])?;
                previous = number(&stop["offset"], previous, 1.)?;
                color(&stop["color"])?;
            }
        }
        _ => return Err(invalid()),
    }
    let layers = scene["layers"]
        .as_array()
        .filter(|l| l.len() <= 100)
        .ok_or_else(invalid)?;
    let mut layer_ids = BTreeSet::new();
    for l in layers {
        object(
            l,
            &[
                "id",
                "assetId",
                "x",
                "y",
                "width",
                "height",
                "rotation",
                "flipX",
                "flipY",
                "opacity",
                "crop",
                "cornerRadius",
                "shadow",
            ],
        )?;
        if !layer_ids.insert(asset_id(&l["id"])?) {
            return Err(invalid());
        }
        ids.insert(asset_id(&l["assetId"])?.into());
        for field in ["x", "y"] {
            number(&l[field], -1_000_000., 1_000_000.)?;
        }
        for field in ["width", "height"] {
            number(&l[field], 0.01, 16000.)?;
        }
        number(&l["rotation"], -3600., 3600.)?;
        number(&l["opacity"], 0., 1.)?;
        number(&l["cornerRadius"], 0., 8000.)?;
        if !l["flipX"].is_boolean() || !l["flipY"].is_boolean() {
            return Err(invalid());
        }
        object(&l["crop"], &["x", "y", "width", "height"])?;
        for field in ["x", "y"] {
            number(&l["crop"][field], 0., 16000.)?;
        }
        for field in ["width", "height"] {
            number(&l["crop"][field], 0.01, 16000.)?;
        }
        let shadow = &l["shadow"];
        object(shadow, &["color", "blur", "offsetX", "offsetY", "opacity"])?;
        color(&shadow["color"])?;
        number(&shadow["blur"], 0., 1000.)?;
        number(&shadow["opacity"], 0., 1.)?;
        for field in ["offsetX", "offsetY"] {
            number(&shadow[field], -1000., 1000.)?;
        }
    }
    let layout = &scene["layout"];
    object(
        layout,
        &["mode", "gap", "padding", "columns", "align", "size"],
    )?;
    if !matches!(
        layout["mode"].as_str(),
        Some("free" | "horizontal" | "vertical" | "grid")
    ) || !matches!(layout["align"].as_str(), Some("start" | "center" | "end"))
    {
        return Err(invalid());
    }
    for field in ["gap", "padding"] {
        number(&layout[field], 0., 16000.)?;
    }
    number(&layout["size"], 0., 16000.)?;
    if layout["columns"].as_u64().is_none_or(|n| n == 0 || n > 100) {
        return Err(invalid());
    }
    Ok(ids)
}

fn validate_scene(conn: &Connection, scene: &Value) -> Result<BTreeSet<String>> {
    let ids = scene_assets(scene)?;
    for id in &ids {
        asset_dimensions(conn, id)?;
    }
    for l in scene["layers"].as_array().ok_or_else(invalid)? {
        let (w, h) = asset_dimensions(conn, asset_id(&l["assetId"])?)?;
        let crop = &l["crop"];
        if number(&crop["x"], 0., f64::from(w))? + number(&crop["width"], 0.01, f64::from(w))?
            > f64::from(w) + 0.001
            || number(&crop["y"], 0., f64::from(h))? + number(&crop["height"], 0.01, f64::from(h))?
                > f64::from(h) + 0.001
        {
            return Err(AppError::invalid("裁剪范围超出原图"));
        }
    }
    Ok(ids)
}
fn asset_dimensions(conn: &Connection, id: &str) -> Result<(u32, u32)> {
    let result = conn
        .query_row(
            "SELECT width,height FROM assets WHERE id=?1 AND sha256 IS NOT NULL",
            [id],
            |r| Ok((r.get::<_, u32>(0)?, r.get::<_, u32>(1)?)),
        )
        .optional()?;
    result.ok_or_else(|| AppError::new("ASSET_MISSING", "图片工程缺少原图"))
}
fn index_assets(conn: &Connection, id: &str, base: &str, ids: &BTreeSet<String>) -> Result<()> {
    conn.execute("DELETE FROM image_project_assets WHERE project_id=?1", [id])?;
    for asset in ids.iter().map(String::as_str).chain(std::iter::once(base)) {
        conn.execute(
            "INSERT OR IGNORE INTO image_project_assets VALUES (?1,?2)",
            params![id, asset],
        )?;
    }
    Ok(())
}
fn project(conn: &Connection, id: &str) -> Result<Value> {
    let (origin,base,raw,version,created,updated,deleted):(String,String,String,i64,i64,i64,Option<i64>)=conn.query_row(
        "SELECT origin_entry_id,base_asset_id,scene_json,version,created_at,updated_at,deleted_at FROM image_projects WHERE id=?1",[id],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)))?;
    Ok(
        json!({"id":id,"originEntryId":origin,"baseAssetId":base,"scene":parse(raw)?,"version":version,"createdAt":created,"updatedAt":updated,"deletedAt":deleted}),
    )
}
fn initial_scene(asset: &str, width: u32, height: u32, orientation: u8) -> Value {
    let mut scene = json!({"schemaVersion":1,"artboard":{"width":width,"height":height,"background":{"type":"transparent"}},"layers":[{
        "id":crate::db::id(),"assetId":asset,"x":0,"y":0,"width":width,"height":height,"rotation":0,"flipX":false,"flipY":false,"opacity":1,
        "crop":{"x":0,"y":0,"width":width,"height":height},"cornerRadius":0,"shadow":{"color":"#000000","blur":0,"offsetX":0,"offsetY":0,"opacity":0}
    }],"layout":{"mode":"free","gap":24,"padding":0,"columns":2,"align":"center","size":0}});
    let layer = &mut scene["layers"][0];
    match orientation {
        2 => layer["flipX"] = json!(true),
        3 => {
            layer["x"] = json!(width);
            layer["y"] = json!(height);
            layer["rotation"] = json!(180);
        }
        4 => layer["flipY"] = json!(true),
        5 | 6 => {
            layer["x"] = json!(height);
            layer["rotation"] = json!(90);
            layer["flipY"] = json!(orientation == 5);
        }
        7 | 8 => {
            layer["y"] = json!(width);
            layer["rotation"] = json!(270);
            layer["flipY"] = json!(orientation == 7);
        }
        _ => {}
    }
    if (5..=8).contains(&orientation) {
        scene["artboard"]["width"] = json!(height);
        scene["artboard"]["height"] = json!(width);
    }
    scene
}

#[tauri::command]
pub async fn image_project_open(
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    entry_id: String,
    src: String,
) -> Result<Value> {
    open_project(&db, &assets, &entry_id, &src).await
}
pub(crate) async fn open_project(
    db: &Workspace,
    assets: &Assets,
    entry_id: &str,
    src: &str,
) -> Result<Value> {
    if !crate::sync::valid_id(entry_id) {
        return Err(invalid());
    }
    let hosted = db.read(|conn| assets::canvas_output_id(conn, src))?;
    let source = hosted.map(|id| format!("asset://{id}"));
    let src = source.as_deref().unwrap_or(src);
    let bytes = assets.read_canvas_original(db, src).await?;
    let (format, width, height) = assets::image_header(&bytes)?;
    let orientation = assets::canvas_orientation(&bytes)?;
    let base = if let Some(id) = src.strip_prefix("asset://") {
        db.read(|conn| asset_dimensions(conn, id))?;
        id.to_owned()
    } else {
        assets.import_canvas(db, "原图", &bytes)?
    };
    let initial = format!(
        "image-{}",
        hex::encode(Sha256::digest(format!("{entry_id}\0{base}")))
    );
    let id=db.read(|conn|Ok(conn.query_row("SELECT s.project_id FROM image_editor_state s JOIN image_projects p ON p.id=s.project_id WHERE s.origin_entry_id=?1 AND s.base_asset_id=?2 AND p.deleted_at IS NULL",params![entry_id,base],|r|r.get::<_,String>(0)).optional()?.unwrap_or(initial)))?;
    let mut value=db.save(|tx|{
        let exists=tx.query_row("SELECT EXISTS(SELECT 1 FROM image_projects WHERE id=?1)",[&id],|r|r.get::<_,bool>(0))?;
        if !exists {
            let frozen:Option<String>=tx.query_row("SELECT scene_json FROM image_renders WHERE output_asset_id=?1",[&base],|r|r.get(0)).optional()?;
            let scene=match frozen{Some(raw)=>parse(raw)?,None=>initial_scene(&base,width,height,orientation)};
            let ids=validate_scene(tx,&scene)?;let timestamp=now();
            tx.execute("INSERT INTO image_projects(id,origin_entry_id,base_asset_id,scene_json,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)",params![id,entry_id,base,encode(&scene)?,timestamp])?;
            index_assets(tx,&id,&base,&ids)?;
        }
        let value=project(tx,&id)?;
        if !value["deletedAt"].is_null(){return Err(AppError::invalid("图片工程已删除，请先处理同步冲突"));}
        Ok(value)
    })?;
    value["animatedInput"] = json!(format == image::ImageFormat::Gif);
    Ok(value)
}

#[tauri::command]
pub fn image_project_save(
    db: State<'_, Workspace>,
    id: String,
    expected_version: i64,
    scene: Value,
) -> Result<Value> {
    save_project(&db, &id, expected_version, &scene)
}
pub(crate) fn save_project(
    db: &Workspace,
    id: &str,
    expected: i64,
    scene: &Value,
) -> Result<Value> {
    db.save(|tx| {
        let (version, base, deleted): (i64, String, Option<i64>) = tx.query_row(
            "SELECT version,base_asset_id,deleted_at FROM image_projects WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        if version != expected {
            return Err(AppError::conflict(version));
        }
        if deleted.is_some() {
            return Err(AppError::invalid("图片工程已删除"));
        }
        let ids = validate_scene(tx, scene)?;
        tx.execute(
            "UPDATE image_projects SET scene_json=?2,version=version+1,updated_at=?3 WHERE id=?1",
            params![id, encode(scene)?, now()],
        )?;
        index_assets(tx, id, &base, &ids)?;
        Ok(json!({"version":version+1}))
    })
}
fn header(request: &Request<'_>, name: &str) -> Result<String> {
    let raw = request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(invalid)?;
    Ok(
        url::form_urlencoded::parse(format!("value={raw}").as_bytes())
            .next()
            .ok_or_else(invalid)?
            .1
            .into_owned(),
    )
}
#[tauri::command]
pub async fn image_canvas_info(
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    url: String,
) -> Result<Value> {
    let id = url
        .strip_prefix("asset://")
        .filter(|id| crate::sync::valid_id(id))
        .ok_or_else(invalid)?;
    let bytes = assets.read_canvas_original(&db, &url).await?;
    let (format, width, height) = assets::image_header(&bytes)?;
    Ok(
        json!({"id":id,"url":url,"width":width,"height":height,"orientation":assets::canvas_orientation(&bytes)?,"animated":format==image::ImageFormat::Gif}),
    )
}
#[tauri::command]
pub async fn image_canvas_read(
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    url: String,
) -> Result<Response> {
    Ok(Response::new(assets.read_canvas(&db, &url).await?))
}
#[tauri::command]
pub async fn image_canvas_import(
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    request: Request<'_>,
) -> Result<Value> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(invalid());
    };
    let name = header(&request, "x-asset-name")?;
    let bytes = assets.normalize_canvas(bytes.clone()).await?;
    let id = assets.import_canvas(&db, &name, &bytes)?;
    let (format, width, height) = assets::image_header(&bytes)?;
    Ok(
        json!({"id":id,"url":format!("asset://{id}"),"width":width,"height":height,"orientation":assets::canvas_orientation(&bytes)?,"animated":format==image::ImageFormat::Gif}),
    )
}
fn export_options(options: &Value, scene: &Value) -> Result<(u32, u32, &'static str)> {
    object(options, &["format", "scale", "quality", "jpegBackground"])?;
    color(&options["jpegBackground"])?;
    number(&options["quality"], 0., 1.)?;
    let scale = options["scale"]
        .as_u64()
        .filter(|s| matches!(s, 1 | 2))
        .ok_or_else(invalid)? as u32;
    let mime = match options["format"].as_str() {
        Some("png") => "image/png",
        Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => return Err(invalid()),
    };
    let (width, height) = dimensions(&scene["artboard"])?;
    assets::validate_dimensions(width * scale, height * scale)?;
    Ok((width * scale, height * scale, mime))
}
fn prepared(id: &str) -> Value {
    let asset = format!("image-output-{id}");
    json!({"renderId":id,"outputAssetId":asset,"src":format!("asset://{asset}")})
}
#[tauri::command]
pub fn image_render_prepare(
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    request: Request<'_>,
) -> Result<Value> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(invalid());
    };
    let id = header(&request, "x-render-id")?;
    if uuid::Uuid::parse_str(&id).is_err() {
        return Err(invalid());
    }
    let project_id = header(&request, "x-project-id")?;
    let version = header(&request, "x-project-version")?
        .parse::<i64>()
        .map_err(|_| invalid())?;
    let options = parse(header(&request, "x-export-options")?)?;
    prepare_render(&db, &assets, &id, &project_id, version, &options, bytes)
}
pub(crate) fn prepare_render(
    db: &Workspace,
    assets: &Assets,
    id: &str,
    project_id: &str,
    version: i64,
    options: &Value,
    bytes: &[u8],
) -> Result<Value> {
    let (format, width, height) = assets::image_header(bytes)?;
    db.save(|tx|{
        let p=project(tx,project_id)?;
        if p["version"]!=version || !p["deletedAt"].is_null(){return Err(AppError::new("VERSION_CONFLICT","图片工程已变更，请重新导出"));}
        let ids=validate_scene(tx,&p["scene"])?;
        let (w,h,mime)=export_options(options,&p["scene"])?;
        if (w,h,mime)!=(width,height,format.to_mime_type()){return Err(AppError::invalid("成品格式或尺寸与导出设置不一致"));}
        let file=assets.stage_canvas(bytes)?;
        let scene=encode(&p["scene"])?;let hash=scene_hash(&p["scene"])?;let output=format!("image-output-{id}");
        if let Some(previous)=render_snapshot(tx,id)? {
            let output_hash=tx.query_row("SELECT sha256 FROM assets WHERE id=?1",[&output],|r|r.get::<_,String>(0))?;
            if previous["projectId"]!=project_id || previous["scene"]!=p["scene"] || previous["exportOptions"]!=*options || output_hash!=file.hash {return Err(AppError::invalid("成品标识已用于其他输出"));}
            return Ok(prepared(id));
        }
        if let Some((previous_hash,previous_scene,previous_options))=tx.query_row("SELECT sha256,scene_json,export_options_json FROM image_render_staging WHERE id=?1",[&id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).optional()? {
            if previous_hash!=file.hash || previous_scene!=scene || previous_options!=encode(options)? {return Err(AppError::invalid("成品标识已用于其他输出"));}
            return Ok(prepared(id));
        }
        tx.execute("INSERT INTO image_render_staging VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![id,project_id,version,scene,hash,serde_json::to_string(&ids).map_err(|_|invalid())?,encode(options)?,output,file.hash,file.relative,file.mime,file.bytes,file.width,file.height,now()])?;
        Ok(prepared(id))
    })
}

#[cfg(test)]
mod tests;

#[tauri::command]
pub fn image_render_commit(
    app: tauri::AppHandle,
    db: State<'_, Workspace>,
    assets: State<'_, Assets>,
    render_id: String,
    entry: Option<Value>,
) -> Result<Value> {
    let result = commit_render(&db, &render_id, entry)?;
    assets.kick();
    let _ = app.emit("assets-changed", ());
    Ok(result)
}
pub(crate) fn commit_render(db: &Workspace, id: &str, entry: Option<Value>) -> Result<Value> {
    let request = json!({"entry":entry});
    let encoded = encode(&request)?;
    db.save(|tx|{
        if let Some((old,result))=tx.query_row("SELECT request_json,result_json FROM image_render_receipts WHERE id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?{
            if old!=encoded{return Err(AppError::invalid("成品已用于其他提交"));}return parse(result);
        }
        let row:Value=tx.query_row("SELECT json_object('projectId',project_id,'scene',json(scene_json),'sceneHash',scene_hash,'outputAssetId',output_asset_id,'assetIds',json(asset_ids_json),'exportOptions',json(export_options_json),'sha256',sha256,'path',relative_path,'mime',mime_type,'bytes',bytes,'width',width,'height',height,'createdAt',created_at) FROM image_render_staging WHERE id=?1",[id],|r|r.get::<_,String>(0)).map_err(AppError::from).and_then(parse)?;
        let asset=asset_id(&row["outputAssetId"])?;let hash=row["sha256"].as_str().ok_or_else(invalid)?;
        validate_scene(tx,&row["scene"])?;
        let previous:Option<String>=tx.query_row("SELECT active_batch FROM sync_progress WHERE id=1",[],|r|r.get(0))?;
        tx.execute("UPDATE sync_progress SET active_batch=?1",[format!("image-render-{id}")])?;
        tx.execute("INSERT INTO assets(id,sha256,mime_type,relative_path,kind,source_key,bytes,created_at,name,width,height,retain_on_exit) VALUES (?1,?2,?3,?4,'original',?5,?6,?7,'图片成品',?8,?9,0)",params![asset,hash,row["mime"].as_str(),row["path"].as_str(),format!("image-render:{id}"),row["bytes"].as_i64(),row["createdAt"].as_i64(),row["width"].as_i64(),row["height"].as_i64()])?;
        tx.execute("INSERT INTO image_renders VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![id,row["projectId"].as_str(),encode(&row["scene"])?,row["sceneHash"].as_str(),asset,encode(&row["assetIds"])?,encode(&row["exportOptions"])?,RENDERER,row["createdAt"].as_i64()])?;
        let mut result=prepared(id);
        if let Some(entry)=&entry {
            let entry_id=asset_id(&entry["id"])?;let version=entry["expectedVersion"].as_i64().ok_or_else(invalid)?;
            if !entry["fields"]["contentMd"].as_str().is_some_and(|md|md.contains(&format!("asset://{asset}"))){return Err(AppError::invalid("正文未引用此次图片成品"));}
            let fields=serde_json::from_value(entry["fields"].clone()).map_err(|_|invalid())?;
            let recovery=entry.get("recovery").filter(|v|!v.is_null()).map(|v|serde_json::from_value(v.clone()).map_err(|_|invalid())).transpose()?;
            let saved=content::save_in_transaction(tx,entry_id,version,fields,SaveMode::Auto,recovery.as_ref())?;
            result["entryVersion"]=serde_json::to_value(saved).map_err(|_|invalid())?["version"].clone();
        }
        tx.execute("UPDATE sync_progress SET active_batch=?1",[previous])?;
        assets::enqueue_canvas_output(tx,asset,hash)?;
        tx.execute("INSERT INTO image_render_receipts VALUES (?1,?2,?3)",params![id,encoded,encode(&result)?])?;
        tx.execute("DELETE FROM image_render_staging WHERE id=?1",[id])?;
        Ok(result)
    })
}

pub(crate) fn project_snapshot(conn: &Connection, id: &str) -> Result<Option<Value>> {
    let exists = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM image_projects WHERE id=?1)",
        [id],
        |r| r.get::<_, bool>(0),
    )?;
    if !exists {
        return Ok(None);
    }
    let p = project(conn, id)?;
    if !p["deletedAt"].is_null() {
        return Ok(None);
    }
    let ids = scene_assets(&p["scene"])?;
    Ok(Some(
        json!({"originEntryId":p["originEntryId"],"baseAssetId":p["baseAssetId"],"scene":p["scene"],"assetIds":ids,"createdAt":p["createdAt"],"updatedAt":p["updatedAt"]}),
    ))
}
pub(crate) fn render_snapshot(conn: &Connection, id: &str) -> Result<Option<Value>> {
    conn.query_row("SELECT json_object('projectId',project_id,'scene',json(scene_json),'sceneHash',scene_hash,'outputAssetId',output_asset_id,'assetIds',json(asset_ids_json),'exportOptions',json(export_options_json),'rendererVersion',renderer_version,'createdAt',created_at) FROM image_renders WHERE id=?1",[id],|r|r.get::<_,String>(0)).optional()?.map(parse).transpose()
}
pub(crate) fn guard_asset_change(
    conn: &Connection,
    id: &str,
    incoming: Option<&str>,
) -> Result<()> {
    let previous: Option<String> = conn
        .query_row("SELECT sha256 FROM assets WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .optional()?
        .flatten();
    if previous
        .as_deref()
        .is_some_and(|hash| Some(hash) != incoming)
        && asset_referenced(conn, id)?
    {
        return Err(AppError::new(
            "IMAGE_ASSET_CONFLICT",
            "原图在两端的内容不同，已保留本地图片工程，请恢复同一原图后重试同步",
        ));
    }
    Ok(())
}
pub(crate) fn asset_referenced(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM image_project_assets WHERE asset_id=?1)
          OR EXISTS(SELECT 1 FROM image_renders r WHERE output_asset_id=?1 OR EXISTS(SELECT 1 FROM json_each(r.asset_ids_json) WHERE value=?1))
          OR EXISTS(SELECT 1 FROM image_render_staging s WHERE output_asset_id=?1 OR EXISTS(SELECT 1 FROM json_each(s.asset_ids_json) WHERE value=?1))",
        [id],|row|row.get::<_,bool>(0))?)
}
pub(crate) fn required_asset_ids(conn: &Connection) -> Result<BTreeSet<String>> {
    let lifecycle:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_version_cleanup')",[],|row|row.get(0))?;
    if lifecycle {
        let mut query=conn.prepare("SELECT asset_id FROM image_project_assets UNION SELECT base_asset_id FROM image_projects
            UNION SELECT r.output_asset_id FROM image_renders r WHERE NOT EXISTS(SELECT 1 FROM assets a JOIN image_version_cleanup c ON c.sha256=a.sha256 WHERE a.id=r.output_asset_id AND c.state IN ('removed','expired')) AND NOT EXISTS(SELECT 1 FROM assets a JOIN image_gc_remote g ON g.sha256=a.sha256 WHERE a.id=r.output_asset_id AND g.state IN ('retired','expired') AND g.payload_json->>'$.current'=1 AND g.payload_json->>'$.backend'='private')
            UNION SELECT j.value FROM image_renders r,json_each(r.asset_ids_json) j WHERE NOT EXISTS(SELECT 1 FROM assets a JOIN image_version_cleanup c ON c.sha256=a.sha256 WHERE a.id=r.output_asset_id AND c.state IN ('removed','expired')) AND NOT EXISTS(SELECT 1 FROM assets a JOIN image_gc_remote g ON g.sha256=a.sha256 WHERE a.id=r.output_asset_id AND g.state IN ('retired','expired') AND g.payload_json->>'$.current'=1 AND g.payload_json->>'$.backend'='private')
            UNION SELECT value FROM image_render_staging,json_each(asset_ids_json)")?;
        return Ok(query.query_map([],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<_>>()?);
    }
    let mut query = conn.prepare(
        "SELECT asset_id FROM image_project_assets
        UNION SELECT base_asset_id FROM image_projects
        UNION SELECT output_asset_id FROM image_renders
        UNION SELECT value FROM image_renders,json_each(asset_ids_json)
        UNION SELECT value FROM image_render_staging,json_each(asset_ids_json)",
    )?;
    Ok(query
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?)
}
fn payload_assets(data: &Value, ids: &BTreeSet<String>) -> Result<()> {
    if serde_json::to_value(ids).map_err(|_| invalid())? != data["assetIds"] {
        return Err(invalid());
    }
    Ok(())
}
pub(crate) fn apply_project(
    conn: &Connection,
    id: &str,
    data: &Value,
    deleted: Option<i64>,
) -> Result<()> {
    let ids = validate_scene(conn, &data["scene"])?;
    payload_assets(data, &ids)?;
    let base = asset_id(&data["baseAssetId"])?;
    asset_dimensions(conn, base)?;
    let origin = asset_id(&data["originEntryId"])?;
    let created = data["createdAt"].as_i64().ok_or_else(invalid)?;
    let updated = data["updatedAt"].as_i64().ok_or_else(invalid)?;
    conn.execute("INSERT INTO image_projects(id,origin_entry_id,base_asset_id,scene_json,created_at,updated_at,deleted_at) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET origin_entry_id=excluded.origin_entry_id,base_asset_id=excluded.base_asset_id,scene_json=excluded.scene_json,version=version+1,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at",params![id,origin,base,encode(&data["scene"])?,created,updated,deleted])?;
    index_assets(conn, id, base, &ids)
}
pub(crate) fn apply_render(
    conn: &Connection,
    id: &str,
    data: &Value,
    deleted: Option<i64>,
) -> Result<()> {
    if deleted.is_some() {
        return Err(invalid());
    }
    let ids = validate_scene(conn, &data["scene"])?;
    payload_assets(data, &ids)?;
    export_options(&data["exportOptions"], &data["scene"])?;
    if let Some(previous) = render_snapshot(conn, id)? {
        if previous != *data {
            return Err(AppError::invalid("图片成品快照不可修改"));
        }
        return Ok(());
    }
    let hash = scene_hash(&data["scene"])?;
    if data["sceneHash"] != hash {
        return Err(invalid());
    }
    let project_id = asset_id(&data["projectId"])?;
    if !conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM image_projects WHERE id=?1)",
        [project_id],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(AppError::invalid("缺少图片工程"));
    }
    let output = asset_id(&data["outputAssetId"])?;
    let (width, height, mime) = export_options(&data["exportOptions"], &data["scene"])?;
    let metadata:(u32,u32,String,String,Option<String>)=conn.query_row("SELECT width,height,mime_type,kind,source_key FROM assets WHERE id=?1 AND sha256 IS NOT NULL",[output],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    if (metadata.0, metadata.1, metadata.2.as_str()) != (width, height, mime)
        || metadata.3 != "original"
        || metadata.4.as_deref() != Some(format!("image-render:{id}").as_str())
    {
        return Err(AppError::invalid("图片成品与工程不一致"));
    }
    conn.execute(
        "INSERT INTO image_renders VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            id,
            project_id,
            encode(&data["scene"])?,
            hash,
            output,
            encode(&data["assetIds"])?,
            encode(&data["exportOptions"])?,
            data["rendererVersion"].as_str().ok_or_else(invalid)?,
            data["createdAt"].as_i64().ok_or_else(invalid)?
        ],
    )?;
    Ok(())
}
