import React from 'react';

export function Metric({label,value,icon,note}:any){return <div className="metric"><div className="metric-top"><span>{label}</span><i>{React.cloneElement(icon,{size:17})}</i></div><b>{value}</b><small>{note}</small></div>}
export function PanelTitle({title,sub,action}:any){return <div className="panel-title"><div><h2>{title}</h2><p>{sub}</p></div>{action}</div>}
export function Empty({text}:any){return <div className="empty"><div>—</div>{text}</div>}
