// Presence order belongs to one authenticated socket stream. HTTP refreshes
// supply private last-seen details, never overwrite realtime online state.
export function initialPresence() {
  return { onlineIds: new Set(), lastSeen: new Map(), revisions: new Map(), watermark: null, now: Date.now(), offset: 0, serverTime: null }
}

function clock(state, action) {
  const stamp = Date.parse(action.server_time)
  if (Number.isFinite(stamp) && (state.serverTime === null || stamp >= state.serverTime)) {
    return { now: stamp, offset: stamp - action.now, serverTime: stamp }
  }
  return { now: Math.max(state.now, action.now + state.offset) }
}

function mergeSeen(previous, users) {
  const next = new Map(previous)
  for (const { user_id, last_seen_at } of users) {
    const stamp = Date.parse(last_seen_at)
    if (Number.isFinite(stamp) && (!next.has(user_id) || stamp > Date.parse(next.get(user_id)))) next.set(user_id, last_seen_at)
  }
  return next
}

export function presenceReducer(state, action) {
  if (action.type === 'clock') return { ...state, ...clock(state, action) }
  if (action.type === 'details') return { ...state, ...clock(state, action), lastSeen: mergeSeen(state.lastSeen, action.users) }
  if (action.type === 'disconnect') return { ...state, onlineIds: new Set(), revisions: new Map(), watermark: null, ...clock(state, action) }
  if (action.type === 'snapshot') {
    const { revision = null } = action
    if (state.watermark !== null && (revision === null || revision < state.watermark)) return state
    const onlineIds = new Set(action.ids)
    // A snapshot queued before a newer per-user update cannot undo it.
    for (const [id, newer] of state.revisions) if (revision !== null && newer > revision) {
      if (state.onlineIds.has(id)) onlineIds.add(id)
      else onlineIds.delete(id)
    }
    return { ...state, onlineIds, watermark: revision, ...clock(state, action) }
  }
  if (action.type === 'update') {
    const { user_id, status, revision = null } = action
    const known = Math.max(state.watermark ?? -1, state.revisions.get(user_id) ?? -1)
    if ((revision !== null && revision <= known) || (revision === null && known >= 0)) return state
    const onlineIds = new Set(state.onlineIds), revisions = new Map(state.revisions)
    if (status === 'online') onlineIds.add(user_id)
    else onlineIds.delete(user_id)
    if (revision !== null) revisions.set(user_id, revision)
    return { ...state, onlineIds, revisions, ...clock(state, action), lastSeen: mergeSeen(state.lastSeen, [action]) }
  }
  return state
}
