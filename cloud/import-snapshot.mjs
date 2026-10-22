// Strict reader for the existing Backlog Markdown frontmatter subset. No SDK/library coupling.
import {createHash} from 'node:crypto';
import {taskInput, canonicalTime, publicSnapshot} from './model.mjs';
const scalar = s => {
  s=s.trim();
  if(s.startsWith('"'))return JSON.parse(s);
  if(s.startsWith("'")){if(!s.endsWith("'"))throw Error('Invalid quoted scalar');return s.slice(1,-1).replaceAll("''","'");}
  if(/^[&*!>|]/.test(s))throw Error('Unsupported frontmatter scalar');
  return s;
};
function frontmatter(raw) {
  const m=/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);if(!m)throw Error('Missing frontmatter');
  const values={};let key;
  for(const line of m[1].split(/\r?\n/)){
    if(!line.trim())continue;
    const field=/^([a-z_]+):\s*(.*)$/.exec(line);
    if(field){key=field[1];if(Object.hasOwn(values,key))throw Error('Duplicate frontmatter key');values[key]=field[2].trim()==='[]'?[]:field[2].trim()===''?[]:scalar(field[2]);}
    else {
      // References are opaque archival text, including Backlog's wrapped four-space continuation lines.
      // They do not determine task identity, status, owner or display group; the full byte archive remains authoritative.
      if(key==='references' && /^    \S/.test(line))continue;
      const item=/^  - (.*)$/.exec(line);if(!item||!Array.isArray(values[key]))throw Error('Unsupported frontmatter structure');values[key].push(key==='references'?item[1]:scalar(item[1]));
    }
  }
  return values;
}
const localTime = value => {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(value))throw Error('Missing source timestamp');
  return canonicalTime(value.replace(' ','T')+(value.length===16?':00':'')+'+09:00');
};
export function convertBacklogFiles(files) {
  const archives=[],tasks=[],records=[],ids=new Set();
  for(const file of [...files].sort((a,b)=>a.filename.localeCompare(b.filename))){
    const bytes=Buffer.from(file.base64,'base64'),raw=bytes.toString('utf8');
    if(Buffer.from(raw,'utf8').compare(bytes)!==0)throw Error('Source is not lossless UTF-8');
    const meta=frontmatter(raw);if(ids.has(meta.id))throw Error('Duplicate source task');ids.add(meta.id);
    // Missing assignee / display-group label stay unset ('' / null); present-but-malformed values are still errors.
    if(meta.assignee!==undefined&&!Array.isArray(meta.assignee))throw Error('Invalid owner');
    if(meta.labels!==undefined&&!Array.isArray(meta.labels))throw Error('Invalid labels');
    const labels=(meta.labels??[]).filter(x=>x.startsWith('表示:'));if(labels.length>1)throw Error('Ambiguous display group');
    const group=labels.length?labels[0].slice(3):null;if(group!==null&&!['現行','要棚卸し','完了履歴'].includes(group))throw Error('Invalid group');
    const recorded=/^observed_at:\s*(\S+)\s*$/m.exec(raw)?.[1];
    let confirmed=null;
    if(recorded)try{confirmed=canonicalTime(recorded);}catch{ /* unrecorded/unknown source markers are not fresh timestamps; full raw source is retained */ }
    const task=taskInput({id:meta.id,title:meta.title,status:meta.status,owner:meta.assignee?.[0]??'',group,detail:raw,lastConfirmedAt:confirmed});
    tasks.push({...task,version:1,updatedAt:localTime(meta.updated_date??meta.created_date)});
    // Private migration record: the source's own dates, kept apart from any import/write time. Unknown stays null.
    records.push({id:meta.id,sourceUpdatedDate:meta.updated_date??null,sourceCreatedDate:meta.created_date??null,updatedAtBasis:meta.updated_date!==undefined?'updated_date':'created_date',ownerUnset:task.owner==='',groupUnset:group===null});
    archives.push({id:meta.id,filename:file.filename,base64:file.base64,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  const board={revision:1,tasks,receipts:{},audit:[]};publicSnapshot(board);
  return{board,archives,records,sourceDigest:createHash('sha256').update(JSON.stringify(archives.map(x=>({id:x.id,filename:x.filename,sha256:x.sha256})).sort((a,b)=>a.id.localeCompare(b.id)))).digest('hex')};
}
