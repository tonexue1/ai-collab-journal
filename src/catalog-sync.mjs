// A detail response is authoritative for its report and human count, including
// when a parse finishes while another workspace is selected.
export function syncCatalogDetail(catalog, detail) {
  if(!catalog||!detail)return catalog;
  const status=detail.report?(detail.report.stale?'stale':'ready'):'unparsed';
  let changed=false;
  const workspaces=catalog.workspaces.map(workspace=>{
    let updated=false;
    const sessions=workspace.sessions.map(session=>{
      if(session.id!==detail.id)return session;
      if(session.status===status&&session.humanCount===detail.humanCount&&!('error' in session))return session;
      updated=changed=true;
      const {error,...rest}=session;
      return {...rest,status,humanCount:detail.humanCount};
    });
    return updated?{...workspace,sessions}:workspace;
  });
  return changed?{...catalog,workspaces}:catalog;
}
