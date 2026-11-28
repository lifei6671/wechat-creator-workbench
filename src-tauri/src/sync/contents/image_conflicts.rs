use super::*;

pub(super) fn resolve(
    db: &Workspace,
    key: &Key,
    choice: Resolution,
    remote_revision: i64,
    local_generation: i64,
) -> Result<Applied> {
    db.write(|tx|{
        let remote=resolution_target(tx,key,remote_revision,local_generation)?;
        let mut changed=Applied::default();
        if matches!(choice,Resolution::Local){
            if remote.deleted_at.is_some(){return Err(AppError::invalid("云端已删除此工程，请另存副本"));}
            remember(tx,key,remote_revision,false)?;
        }else{
            if matches!(choice,Resolution::Copy){
                let local=local_snapshot(tx,key)?.ok_or_else(||AppError::invalid("本地工程已删除，无法另存副本"))?;
                let copy=id();
                crate::image_canvas::apply_project(tx,&copy,&local,None)?;
                tx.execute("INSERT INTO image_editor_state VALUES (?1,?2,?3) ON CONFLICT(origin_entry_id,base_asset_id) DO UPDATE SET project_id=excluded.project_id",params![local["originEntryId"].as_str(),local["baseAssetId"].as_str(),copy])?;
                changed.changed_image_projects.push(copy);
            }
            let grouped:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sync_inbox WHERE group_size>1 AND payload_json->>'$.entityType'=?1 AND payload_json->>'$.entityId'=?2 AND payload_json->>'$.remoteRevision'=?3)",params![key.entity_type.key(),key.entity_id,remote_revision],|row|row.get(0))?;
            if !grouped {
                let capture:bool=tx.query_row("SELECT capture FROM sync_progress",[],|r|r.get(0))?;
                tx.execute("UPDATE sync_progress SET capture=0",[])?;
                changed.extend(apply_group(tx,vec![remote])?);
                tx.execute("UPDATE sync_progress SET capture=?1",[capture])?;
            }
            tx.execute("DELETE FROM sync_dirty WHERE (entity_type,entity_id)=(?1,?2)",params![key.entity_type.key(),key.entity_id])?;
        }
        tx.execute("DELETE FROM sync_issues WHERE (entity_type,entity_id)=(?1,?2)",params![key.entity_type.key(),key.entity_id])?;
        changed.extend(apply_received_transaction(tx,None)?);
        Ok(changed)
    })
}
