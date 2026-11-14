import { randomBytes } from 'node:crypto';

// Owner-only native identifiers. Receivers see fresh opaque keys and approved
// labels, never a desktop target or an arbitrary native capture argument.
export function createWindowTargets(raw, initial) {
  if (raw === undefined) return null;
  if (!initial?.windowId || !initial?.windowOwnerPid || !Array.isArray(raw) || raw.length < 2 || raw.length > 8)
    throw Error('Choose between two and eight windows before allowing window switching.');
  const ids = new Set();
  const targets = raw.map(value => {
    if (!value || Array.isArray(value) || Object.keys(value).length !== 3
        || Object.keys(value).some(k => !['id','ownerPid','label'].includes(k))
        || !Number.isInteger(value.id) || value.id < 1 || value.id > 0xffffffff
        || !Number.isInteger(value.ownerPid) || value.ownerPid < 1 || value.ownerPid > 0x7fffffff
        || ids.has(value.id) || typeof value.label !== 'string' || value.label.length > 80)
      throw Error('Refresh the window list and choose the windows again.');
    ids.add(value.id);
    const label = value.label.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,' ').trim();
    if (!label) throw Error('Give each selected window a readable name.');
    return Object.freeze({id:value.id,ownerPid:value.ownerPid,label,key:randomBytes(12).toString('base64url')});
  });
  const selected = targets.find(t => t.id === initial.windowId && t.ownerPid === initial.windowOwnerPid);
  if (!selected) throw Error('Include the initial window in the selected windows.');
  return Object.freeze({grant:randomBytes(12).toString('base64url'),targets:Object.freeze(targets),initial:selected});
}

export function publicWindowState(group, current, switching) {
  return {type:'window-state',grant:group.grant,current:current.key,switching,
    windows:group.targets.map(({key,label})=>({key,label}))};
}
