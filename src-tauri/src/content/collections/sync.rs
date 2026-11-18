use super::{Geometry, Position, edge_label, parse_web_url, validate_position};
use crate::assets::references;
use crate::db::{AppError, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Topic {
    title: String,
    description: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Card {
    collection_id: String,
    kind: String,
    entry_id: Option<String>,
    asset_id: Option<String>,
    content_md: String,
    external_url: Option<String>,
    color: Option<String>,
    custom_color: Option<String>,
    #[serde(flatten)]
    geometry: Geometry,
    created_at: i64,
    updated_at: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    asset_ids: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Link {
    collection_id: String,
    source_node_id: String,
    target_node_id: String,
    label: String,
    created_at: i64,
}

pub fn snapshot_topic(conn: &Connection, id: &str) -> Result<Option<Value>> {
    Ok(conn
        .query_row(
            "SELECT title,description,created_at,updated_at FROM collections WHERE id=?1",
            [id],
            |row| {
                Ok(json!({
                    "title":row.get::<_,String>(0)?,"description":row.get::<_,String>(1)?,
                    "createdAt":row.get::<_,i64>(2)?,"updatedAt":row.get::<_,i64>(3)?,
                }))
            },
        )
        .optional()?)
}

pub fn snapshot_card(conn: &Connection, id: &str) -> Result<Option<Value>> {
    let Some(mut card) = conn.query_row(
        "SELECT collection_id,kind,entry_id,asset_id,content_md,external_url,color,custom_color,
            x,y,width,height,created_at,updated_at FROM collection_nodes WHERE id=?1",
        [id], |row| Ok(Card {
            collection_id:row.get(0)?, kind:row.get(1)?, entry_id:row.get(2)?, asset_id:row.get(3)?,
            content_md:row.get(4)?,external_url:row.get(5)?,color:row.get(6)?,custom_color:row.get(7)?,
            geometry:Geometry { position:Position { x:row.get(8)?,y:row.get(9)? }, width:row.get(10)?,height:row.get(11)? },
            created_at:row.get(12)?,updated_at:row.get(13)?,asset_ids:Vec::new(),
        }),
    ).optional()? else { return Ok(None); };
    if card.kind == "text" {
        let mut known = conn.prepare_cached("SELECT id FROM assets WHERE id=?1")?;
        for url in references::urls(&card.content_md)? {
            if let Some(id) = url.strip_prefix("asset://")
                && let Some(asset) = known.query_row([id], |row| row.get(0)).optional()?
            {
                card.asset_ids.push(asset);
            }
        }
    }
    Ok(Some(serde_json::to_value(card).map_err(invalid)?))
}

pub fn snapshot_link(conn: &Connection, id: &str) -> Result<Option<Value>> {
    conn.query_row(
        "SELECT collection_id,source_node_id,target_node_id,label,created_at FROM collection_edges WHERE id=?1",
        [id], |row| Ok(Link { collection_id:row.get(0)?,source_node_id:row.get(1)?,target_node_id:row.get(2)?,
            label:row.get(3)?,created_at:row.get(4)? }),
    ).optional()?.map(serde_json::to_value).transpose().map_err(invalid)
}

pub fn apply_topic(
    conn: &Connection,
    id: &str,
    data: &Value,
    deleted: bool,
) -> Result<Option<String>> {
    if deleted {
        let children: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_nodes WHERE collection_id=?1)
                OR EXISTS(SELECT 1 FROM collection_edges WHERE collection_id=?1)",
            [id],
            |row| row.get(0),
        )?;
        if children {
            return Err(in_use());
        }
        return Ok(
            (conn.execute("DELETE FROM collections WHERE id=?1", [id])? > 0).then(|| id.to_owned()),
        );
    }
    let topic: Topic = serde_json::from_value(data.clone()).map_err(invalid)?;
    conn.execute(
        "INSERT INTO collections (id,title,description,created_at,updated_at) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,
            created_at=excluded.created_at,updated_at=excluded.updated_at",
        params![id,topic.title,topic.description,topic.created_at,topic.updated_at],
    )?;
    Ok(Some(id.to_owned()))
}

pub fn apply_card(
    conn: &Connection,
    id: &str,
    data: &Value,
    deleted: bool,
) -> Result<Option<String>> {
    if deleted {
        let edges: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_edges WHERE source_node_id=?1 OR target_node_id=?1)",
            [id], |row| row.get(0),
        )?;
        if edges {
            return Err(in_use());
        }
        return Ok(conn
            .query_row(
                "DELETE FROM collection_nodes WHERE id=?1 RETURNING collection_id",
                [id],
                |row| row.get(0),
            )
            .optional()?);
    }
    let card: Card = serde_json::from_value(data.clone()).map_err(invalid)?;
    let Geometry {
        position,
        width,
        height,
    } = card.geometry;
    validate_position(&position)?;
    if !(1.0..=1200.0).contains(&width) || !(1.0..=1000.0).contains(&height) {
        return Err(AppError::invalid("画布卡片尺寸超出范围"));
    }
    if let Some(url) = &card.external_url {
        parse_web_url(url)?;
    }
    let inserted = conn.execute(
        "INSERT INTO collection_nodes (id,collection_id,kind,entry_id,asset_id,content_md,external_url,
            color,custom_color,x,y,width,height,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,entry_id=excluded.entry_id,asset_id=excluded.asset_id,
            content_md=excluded.content_md,external_url=excluded.external_url,color=excluded.color,custom_color=excluded.custom_color,
            x=excluded.x,y=excluded.y,width=excluded.width,height=excluded.height,created_at=excluded.created_at,updated_at=excluded.updated_at
         WHERE collection_nodes.collection_id=excluded.collection_id",
        params![id,card.collection_id,card.kind,card.entry_id,card.asset_id,card.content_md,card.external_url,
            card.color,card.custom_color,position.x,position.y,width,height,card.created_at,card.updated_at],
    )?;
    super::changed(inserted)?;
    Ok(Some(card.collection_id))
}

pub fn apply_link(
    conn: &Connection,
    id: &str,
    data: &Value,
    deleted: bool,
) -> Result<Option<String>> {
    if deleted {
        return Ok(conn
            .query_row(
                "DELETE FROM collection_edges WHERE id=?1 RETURNING collection_id",
                [id],
                |row| row.get(0),
            )
            .optional()?);
    }
    let link: Link = serde_json::from_value(data.clone()).map_err(invalid)?;
    let inserted = conn.execute(
        "INSERT INTO collection_edges (id,collection_id,source_node_id,target_node_id,label,created_at)
         SELECT ?1,?2,?3,?4,?5,?6 WHERE (
           SELECT COUNT(*) FROM collection_nodes WHERE collection_id=?2 AND id IN (?3,?4))=2
         ON CONFLICT(id) DO UPDATE SET source_node_id=excluded.source_node_id,target_node_id=excluded.target_node_id,
            label=excluded.label,created_at=excluded.created_at WHERE collection_edges.collection_id=excluded.collection_id",
        params![id,link.collection_id,link.source_node_id,link.target_node_id,edge_label(&link.label)?,link.created_at],
    )?;
    super::changed(inserted)?;
    Ok(Some(link.collection_id))
}

fn invalid(error: serde_json::Error) -> AppError {
    AppError::new("SYNC_PROTOCOL", format!("专题同步数据无效：{error}"))
}

fn in_use() -> AppError {
    AppError::new(
        "SYNC_CANVAS_IN_USE",
        "本机仍有相关卡片或连线，已保留本地专题变更",
    )
}
