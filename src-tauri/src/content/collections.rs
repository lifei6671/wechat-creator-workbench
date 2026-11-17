use super::{Fields, Kind, entry_preview, insert_entry};
use crate::db::{AppError, Result, Workspace, id, now};
use rusqlite::{Connection, Row, params};
use serde::{Deserialize, Serialize};

const COLLECTIONS: &str = "SELECT c.id,c.title,c.description,c.created_at,c.updated_at,
    c.viewport_x,c.viewport_y,c.viewport_zoom,
    (SELECT COUNT(*) FROM collection_nodes WHERE collection_id=c.id) FROM collections c";

const NODES: &str = "SELECT n.id,n.collection_id,n.kind,n.entry_id,n.asset_id,n.content_md,
    n.x,n.y,n.width,n.height,n.created_at,n.updated_at,e.title,e.kind,e.summary,e.deleted_at,s.account_name,
    CASE WHEN TRIM(e.summary)='' AND e.deleted_at IS NULL THEN SUBSTR(e.content_md,1,1024) ELSE '' END,
    a.name,COALESCE(n.custom_color,n.color)
    FROM collection_nodes n LEFT JOIN entries e ON e.id=n.entry_id LEFT JOIN sources s ON s.id=e.source_id
    LEFT JOIN assets a ON a.id=n.asset_id";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    id: String,
    title: String,
    description: String,
    created_at: i64,
    updated_at: i64,
    viewport: Viewport,
    node_count: i64,
}

#[derive(Deserialize, Serialize)]
pub struct Viewport {
    x: f64,
    y: f64,
    zoom: f64,
}

#[derive(Deserialize, Serialize)]
pub struct Position {
    x: f64,
    y: f64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    #[serde(flatten)]
    position: Position,
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeGeometry {
    node_id: String,
    #[serde(flatten)]
    geometry: Geometry,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum NodeContent {
    Entry { entry_id: String },
    Image { asset_id: String },
    Text { content_md: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntrySummary {
    title: String,
    kind: String,
    summary: String,
    deleted_at: Option<i64>,
    source_platform: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasNode {
    id: String,
    collection_id: String,
    kind: String,
    entry_id: Option<String>,
    asset_id: Option<String>,
    asset_name: Option<String>,
    content_md: String,
    color: Option<String>,
    #[serde(flatten)]
    geometry: Geometry,
    created_at: i64,
    updated_at: i64,
    entry: Option<EntrySummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasEdge {
    id: String,
    collection_id: String,
    source_node_id: String,
    target_node_id: String,
    label: String,
    created_at: i64,
}

#[derive(Serialize)]
pub struct CollectionCanvas {
    collection: Collection,
    nodes: Vec<CanvasNode>,
    edges: Vec<CanvasEdge>,
}

impl Workspace {
    pub fn list_collections(&self) -> Result<Vec<Collection>> {
        self.read(|conn| {
            Ok(conn
                .prepare(&format!("{COLLECTIONS} ORDER BY c.rowid"))?
                .query_map([], collection_row)?
                .collect::<rusqlite::Result<_>>()?)
        })
    }

    pub fn save_collection(
        &self,
        collection_id: Option<&str>,
        title: &str,
        description: &str,
    ) -> Result<Collection> {
        let title = title.trim();
        if title.is_empty() {
            return Err(AppError::invalid("请输入专题名称"));
        }
        self.write(|tx| {
            let timestamp = now();
            let new_id;
            let collection_id = if let Some(collection_id) = collection_id {
                changed(tx.execute(
                    "UPDATE collections SET title=?2,description=?3,updated_at=?4 WHERE id=?1",
                    params![collection_id, title, description, timestamp],
                )?)?;
                collection_id
            } else {
                new_id = id();
                tx.execute(
                    "INSERT INTO collections (id,title,description,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)",
                    params![new_id, title, description, timestamp],
                )?;
                &new_id
            };
            collection(tx, collection_id)
        })
    }

    pub fn delete_collection(&self, collection_id: &str) -> Result<()> {
        self.write(|tx| {
            changed(tx.execute("DELETE FROM collections WHERE id=?1", [collection_id])?)
        })
    }

    pub fn collection_canvas(&self, collection_id: &str) -> Result<CollectionCanvas> {
        self.read(|conn| {
            let collection = collection(conn, collection_id)?;
            let nodes = conn
                .prepare(&format!(
                    "{NODES} WHERE n.collection_id=?1 ORDER BY n.created_at,n.id"
                ))?
                .query_map([collection_id], node_row)?
                .collect::<rusqlite::Result<_>>()?;
            let edges = conn
                .prepare(
                    "SELECT id,collection_id,source_node_id,target_node_id,label,created_at
                 FROM collection_edges WHERE collection_id=?1 ORDER BY created_at,id",
                )?
                .query_map([collection_id], |row| {
                    Ok(CanvasEdge {
                        id: row.get(0)?,
                        collection_id: row.get(1)?,
                        source_node_id: row.get(2)?,
                        target_node_id: row.get(3)?,
                        label: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(CollectionCanvas {
                collection,
                nodes,
                edges,
            })
        })
    }

    pub fn create_collection_node(
        &self,
        collection_id: &str,
        content: NodeContent,
        position: Position,
    ) -> Result<CanvasNode> {
        validate_position(&position)?;
        self.write(|tx| {
            changed(tx.execute(
                "UPDATE collections SET updated_at=?2 WHERE id=?1", params![collection_id, now()],
            )?)?;
            let (kind, entry_id, asset_id, markdown, height) = match content {
                NodeContent::Entry { ref entry_id } => {
                    let available: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM entries WHERE id=?1 AND deleted_at IS NULL)",
                        [entry_id], |row| row.get(0),
                    )?;
                    if !available {
                        return Err(AppError::invalid("找不到可添加的文章"));
                    }
                    ("entry", Some(entry_id), None, "", 144)
                }
                NodeContent::Image { ref asset_id } => {
                    let exists: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1)", [asset_id], |row| row.get(0),
                    )?;
                    if !exists {
                        return Err(AppError::invalid("找不到可添加的图片"));
                    }
                    tx.execute(
                        "DELETE FROM jobs WHERE kind='cleanup' AND status<>'completed'
                         AND sha256=(SELECT sha256 FROM assets WHERE id=?1)", [asset_id],
                    )?;
                    ("image", None, Some(asset_id), "", 224)
                }
                NodeContent::Text { ref content_md } => ("text", None, None, content_md.as_str(), 200),
            };
            let node_id = id();
            tx.execute(
                "INSERT INTO collection_nodes
                 (id,collection_id,kind,entry_id,asset_id,content_md,x,y,height,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)",
                params![node_id, collection_id, kind, entry_id, asset_id, markdown,
                        position.x, position.y, height, now()],
            )?;
            node(tx, &node_id)
        })
    }

    pub fn update_collection_node_text(&self, node_id: &str, markdown: &str) -> Result<()> {
        self.write(|tx| {
            changed(tx.execute(
            "UPDATE collection_nodes SET content_md=?2,updated_at=?3 WHERE id=?1 AND kind='text'",
            params![node_id, markdown, now()],
        )?)
        })
    }

    pub fn update_collection_node_geometry(&self, updates: Vec<NodeGeometry>) -> Result<()> {
        self.write(|tx| {
            let mut update = tx.prepare_cached(
                "UPDATE collection_nodes SET x=?2,y=?3,width=?4,height=?5,updated_at=?6 WHERE id=?1",
            )?;
            let timestamp = now();
            for NodeGeometry { node_id, geometry } in updates {
                let Geometry { position, width, height } = geometry;
                validate_position(&position)?;
                if !(1.0..=1200.0).contains(&width) || !(1.0..=1000.0).contains(&height) {
                    return Err(AppError::invalid("画布卡片尺寸超出范围"));
                }
                changed(update.execute(params![node_id, position.x, position.y, width, height, timestamp])?)?;
            }
            Ok(())
        })
    }

    pub fn update_collection_node_color(&self, node_id: &str, color: Option<&str>) -> Result<()> {
        let (preset, custom) = match color {
            None => (None, None),
            Some(value @ ("red" | "orange" | "amber" | "green" | "blue" | "violet")) => {
                (Some(value), None)
            }
            Some(value)
                if value.len() == 7
                    && value
                        .strip_prefix('#')
                        .is_some_and(|hex| hex.bytes().all(|digit| digit.is_ascii_hexdigit())) =>
            {
                (None, Some(value))
            }
            Some(_) => return Err(AppError::invalid("不支持的画布卡片颜色")),
        };
        self.write(|tx| {
            changed(tx.execute(
                "UPDATE collection_nodes SET color=?2,custom_color=?3,updated_at=?4 WHERE id=?1",
                params![node_id, preset, custom, now()],
            )?)
        })
    }

    pub fn delete_collection_node(&self, node_id: &str) -> Result<()> {
        self.write(|tx| changed(tx.execute("DELETE FROM collection_nodes WHERE id=?1", [node_id])?))
    }

    pub fn convert_collection_text(&self, node_id: &str) -> Result<CanvasNode> {
        self.write(|tx| {
            let markdown: String = tx.query_row(
                "SELECT content_md FROM collection_nodes WHERE id=?1 AND kind='text'",
                [node_id], |row| row.get(0),
            )?;
            let kind = Kind::Article;
            let mut fields = Fields::empty(kind);
            fields.title = markdown.lines().map(|line| line.trim().trim_start_matches('#').trim())
                .find(|line| !line.is_empty()).unwrap_or_default().chars().take(80).collect();
            fields.content_md = markdown;
            let entry = insert_entry(tx, kind, fields, None)?;
            tx.execute(
                "UPDATE collection_nodes SET kind='entry',entry_id=?2,content_md='',updated_at=?3 WHERE id=?1",
                params![node_id, entry.row.id, now()],
            )?;
            node(tx, node_id)
        })
    }

    pub fn create_collection_edge(
        &self,
        collection_id: String,
        source_node_id: String,
        target_node_id: String,
        label: String,
    ) -> Result<CanvasEdge> {
        self.write(|tx| {
            let endpoints: i64 = tx.query_row(
                "SELECT COUNT(*) FROM collection_nodes WHERE collection_id=?1 AND id IN (?2,?3)",
                params![collection_id, source_node_id, target_node_id],
                |row| row.get(0),
            )?;
            if endpoints != 2 {
                return Err(AppError::invalid("请选择同一专题中的两个不同节点"));
            }
            let edge = CanvasEdge {
                id: id(),
                collection_id,
                source_node_id,
                target_node_id,
                label: edge_label(&label)?.into(),
                created_at: now(),
            };
            tx.execute(
                "INSERT INTO collection_edges VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    edge.id,
                    edge.collection_id,
                    edge.source_node_id,
                    edge.target_node_id,
                    edge.label,
                    edge.created_at
                ],
            )?;
            Ok(edge)
        })
    }

    pub fn update_collection_edge(&self, edge_id: &str, label: &str) -> Result<()> {
        let label = edge_label(label)?;
        self.write(|tx| {
            changed(tx.execute(
                "UPDATE collection_edges SET label=?2 WHERE id=?1",
                params![edge_id, label],
            )?)
        })
    }

    pub fn delete_collection_edge(&self, edge_id: &str) -> Result<()> {
        self.write(|tx| changed(tx.execute("DELETE FROM collection_edges WHERE id=?1", [edge_id])?))
    }

    pub fn save_collection_viewport(&self, collection_id: &str, viewport: Viewport) -> Result<()> {
        if !viewport.x.is_finite()
            || !viewport.y.is_finite()
            || !(0.1..=3.0).contains(&viewport.zoom)
        {
            return Err(AppError::invalid("画布视口超出范围"));
        }
        self.write(|tx| {
            changed(tx.execute(
                "UPDATE collections SET viewport_x=?2,viewport_y=?3,viewport_zoom=?4 WHERE id=?1",
                params![collection_id, viewport.x, viewport.y, viewport.zoom],
            )?)
        })
    }

    pub fn list_entry_collections(&self, entry_id: &str) -> Result<Vec<Collection>> {
        self.read(|conn| {
            Ok(conn
                .prepare(&format!(
                    "{COLLECTIONS} WHERE c.id IN
                (SELECT collection_id FROM collection_nodes WHERE entry_id=?1)
                ORDER BY c.title COLLATE NOCASE,c.id"
                ))?
                .query_map([entry_id], collection_row)?
                .collect::<rusqlite::Result<_>>()?)
        })
    }
}

fn collection(conn: &Connection, collection_id: &str) -> Result<Collection> {
    Ok(conn.query_row(
        &format!("{COLLECTIONS} WHERE c.id=?1"),
        [collection_id],
        collection_row,
    )?)
}

fn collection_row(row: &Row<'_>) -> rusqlite::Result<Collection> {
    Ok(Collection {
        id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        viewport: Viewport {
            x: row.get(5)?,
            y: row.get(6)?,
            zoom: row.get(7)?,
        },
        node_count: row.get(8)?,
    })
}

fn node(conn: &Connection, node_id: &str) -> Result<CanvasNode> {
    Ok(conn.query_row(&format!("{NODES} WHERE n.id=?1"), [node_id], node_row)?)
}

fn node_row(row: &Row<'_>) -> rusqlite::Result<CanvasNode> {
    let entry = if let Some(title) = row.get::<_, Option<String>>(12)? {
        let summary: String = row.get(14)?;
        let excerpt: String = row.get(17)?;
        Some(EntrySummary {
            title,
            kind: row.get(13)?,
            summary: entry_preview(&summary, None, &excerpt, Vec::new()).summary,
            deleted_at: row.get(15)?,
            source_platform: row.get(16)?,
        })
    } else {
        None
    };
    Ok(CanvasNode {
        id: row.get(0)?,
        collection_id: row.get(1)?,
        kind: row.get(2)?,
        entry_id: row.get(3)?,
        asset_id: row.get(4)?,
        asset_name: row.get(18)?,
        content_md: row.get(5)?,
        color: row.get(19)?,
        geometry: Geometry {
            position: Position {
                x: row.get(6)?,
                y: row.get(7)?,
            },
            width: row.get(8)?,
            height: row.get(9)?,
        },
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        entry,
    })
}

fn changed(count: usize) -> Result<()> {
    if count == 0 {
        return Err(AppError::new("NOT_FOUND", "找不到对应的专题、卡片或连线"));
    }
    Ok(())
}

fn validate_position(position: &Position) -> Result<()> {
    if !position.x.is_finite() || !position.y.is_finite() {
        return Err(AppError::invalid("画布坐标无效"));
    }
    Ok(())
}

fn edge_label(label: &str) -> Result<&str> {
    let label = label.trim();
    if label.chars().count() > 120 || label.contains(['\n', '\r']) {
        return Err(AppError::invalid("连线说明最多 120 个字符，请使用单行文字"));
    }
    Ok(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canvas_image_exposes_the_asset_name() {
        let folder = tempfile::tempdir().unwrap();
        let db = Workspace::open(&folder.path().join("workspace.db")).unwrap();
        let collection = db.save_collection(None, "专题", "").unwrap();
        db.write(|tx| {
            tx.execute(
                "INSERT INTO assets (id,kind,name,created_at) VALUES ('image','original',?1,0)",
                ["原图.png"],
            )?;
            Ok(())
        })
        .unwrap();
        db.create_collection_node(
            &collection.id,
            NodeContent::Image {
                asset_id: "image".into(),
            },
            Position { x: 0.0, y: 0.0 },
        )
        .unwrap();
        let canvas = db.collection_canvas(&collection.id).unwrap();
        assert_eq!(canvas.nodes[0].asset_name.as_deref(), Some("原图.png"));
    }

    #[test]
    fn lists_collections_in_creation_order_after_editing_an_earlier_topic() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("workspace.db");
        let db = Workspace::open(&path).unwrap();
        let first = db.save_collection(None, "先创建", "").unwrap();
        let second = db.save_collection(None, "后创建", "").unwrap();
        db.save_collection(Some(&first.id), "重新命名", "").unwrap();
        db.write(|tx| {
            tx.execute(
                "UPDATE collections SET updated_at = updated_at + 86400 WHERE id = ?",
                [&first.id],
            )?;
            Ok(())
        })
        .unwrap();
        drop(db);
        let db = Workspace::open(&path).unwrap();
        let items = db.list_collections().unwrap();
        assert_eq!(
            items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            [first.id.as_str(), second.id.as_str()]
        );
        assert_eq!(items[0].title, "重新命名");
    }

    #[test]
    fn persists_independent_references_and_cascades_edges_without_deleting_articles() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("workspace.db");
        let db = Workspace::open(&path).unwrap();
        let entry = db.create_entry(Kind::Article, None, None).unwrap();
        let first = db.save_collection(None, "研究主题", "记录").unwrap();
        let second = db.save_collection(None, "另一专题", "").unwrap();
        let add = |collection: &Collection| {
            db.create_collection_node(
                &collection.id,
                NodeContent::Entry {
                    entry_id: entry.row.id.clone(),
                },
                Position { x: 12.0, y: 40.0 },
            )
            .unwrap()
        };
        let left = add(&first);
        let right = add(&first);
        let other = add(&second);
        assert_ne!(left.id, right.id);
        assert_eq!(left.color, None);
        db.update_collection_node_color(&left.id, Some("violet"))
            .unwrap();
        db.update_collection_node_color(&right.id, Some("green"))
            .unwrap();
        db.update_collection_node_color(&right.id, Some("#13af9C"))
            .unwrap();
        assert!(
            db.update_collection_node_color(&left.id, Some("invalid"))
                .is_err()
        );
        assert!(
            db.update_collection_node_color(&right.id, Some("#ffzz00"))
                .is_err()
        );
        assert_eq!(db.list_entry_collections(&entry.row.id).unwrap().len(), 2);
        assert!(
            db.create_collection_edge(first.id.clone(), left.id.clone(), other.id, "".into())
                .is_err()
        );
        assert!(
            db.create_collection_edge(
                first.id.clone(),
                left.id.clone(),
                left.id.clone(),
                "".into()
            )
            .is_err()
        );
        let edge = db
            .create_collection_edge(
                first.id.clone(),
                left.id.clone(),
                right.id.clone(),
                "".into(),
            )
            .unwrap();
        db.update_collection_edge(&edge.id, "相关").unwrap();
        db.update_collection_node_geometry(vec![NodeGeometry {
            node_id: left.id.clone(),
            geometry: Geometry {
                position: Position { x: -32.0, y: 80.0 },
                width: 480.0,
                height: 240.0,
            },
        }])
        .unwrap();
        db.save_collection_viewport(
            &first.id,
            Viewport {
                x: 60.0,
                y: -60.0,
                zoom: 1.25,
            },
        )
        .unwrap();
        assert_eq!(db.get_entry(&entry.row.id).unwrap().version, entry.version);
        let deleted = db.set_deleted(&entry.row.id, entry.version, true).unwrap();
        drop(db);

        let db = Workspace::open(&path).unwrap();
        let canvas = db.collection_canvas(&first.id).unwrap();
        assert_eq!(canvas.collection.node_count, 2);
        assert_eq!(canvas.collection.viewport.zoom, 1.25);
        assert_eq!(canvas.edges[0].label, "相关");
        let moved = canvas.nodes.iter().find(|node| node.id == left.id).unwrap();
        assert_eq!(moved.geometry.position.x, -32.0);
        assert_eq!(moved.geometry.width, 480.0);
        assert_eq!(moved.color.as_deref(), Some("violet"));
        assert_eq!(
            canvas
                .nodes
                .iter()
                .find(|node| node.id == right.id)
                .unwrap()
                .color
                .as_deref(),
            Some("#13af9C")
        );
        db.update_collection_node_color(&right.id, Some("red"))
            .unwrap();
        db.read(|conn| {
            assert_eq!(node(conn, &right.id)?.color.as_deref(), Some("red"));
            Ok(())
        })
        .unwrap();
        db.update_collection_node_color(&right.id, None).unwrap();
        db.read(|conn| {
            assert_eq!(node(conn, &right.id)?.color, None);
            Ok(())
        })
        .unwrap();
        assert!(moved.entry.as_ref().unwrap().deleted_at.is_some());
        db.set_deleted(&entry.row.id, deleted.version, false)
            .unwrap();
        assert!(
            db.collection_canvas(&first.id).unwrap().nodes[0]
                .entry
                .as_ref()
                .unwrap()
                .deleted_at
                .is_none()
        );
        db.delete_collection_node(&left.id).unwrap();
        assert!(db.collection_canvas(&first.id).unwrap().edges.is_empty());
        db.delete_collection(&first.id).unwrap();
        assert_eq!(db.list_entry_collections(&entry.row.id).unwrap().len(), 1);
        assert!(db.get_entry(&entry.row.id).is_ok());
    }

    #[test]
    fn only_indexes_text_after_converting_it_to_an_article() {
        let folder = tempfile::tempdir().unwrap();
        let db = Workspace::open(&folder.path().join("workspace.db")).unwrap();
        let collection = db.save_collection(None, "专题", "").unwrap();
        let text = db
            .create_collection_node(
                &collection.id,
                NodeContent::Text {
                    content_md: "旧内容".into(),
                },
                Position { x: 0.0, y: 0.0 },
            )
            .unwrap();
        db.update_collection_node_text(&text.id, "# 独有标题\n\n待整理的摘录")
            .unwrap();
        let search = || {
            db.entries(super::super::Filter {
                query: Some("独有标题".into()),
                ..Default::default()
            })
            .unwrap()
        };
        assert!(search().items.is_empty());
        let node = db.convert_collection_text(&text.id).unwrap();
        assert_eq!(node.id, text.id);
        assert_eq!(node.kind, "entry");
        assert!(node.content_md.is_empty());
        let entry = db.get_entry(node.entry_id.as_ref().unwrap()).unwrap();
        assert_eq!(entry.row.status, "draft");
        assert_eq!(entry.fields.content_md, "# 独有标题\n\n待整理的摘录");
        assert_eq!(search().items[0].id, entry.row.id);
        assert!(db.convert_collection_text(&text.id).is_err());
    }
}
