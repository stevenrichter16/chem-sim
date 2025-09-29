export const HISTORY_DURATION_MS = 10000;
export const HISTORY_SAMPLE_MS = 150;

const historySubscribers = new Set();

export function ensureHistoryBuffer(tile){
  if(!tile) return null;
  if(!tile.history) tile.history=[];
  if(!tile._historyMeta) tile._historyMeta={ lastSampleAt: -Infinity };
  return tile.history;
}

export function subscribeHistory(tile){
  if(!tile) return;
  ensureHistoryBuffer(tile);
  historySubscribers.add(tile);
}

export function unsubscribeHistory(tile, {clear=false}={}){
  if(!tile) return;
  historySubscribers.delete(tile);
  if(clear && tile.history) tile.history.length=0;
  if(tile._historyMeta) tile._historyMeta.lastSampleAt = -Infinity;
}

export function clearSubscribers(){
  historySubscribers.clear();
}

export function recordSubscribedHistories(now){
  if(!historySubscribers.size) return;
  const cutoff = now - HISTORY_DURATION_MS;
  for(const tile of historySubscribers){
    if(!tile) continue;
    const history = ensureHistoryBuffer(tile);
    if(!history) continue;
    const meta = tile._historyMeta;
    if(meta && (now - (meta.lastSampleAt||-Infinity)) < HISTORY_SAMPLE_MS) continue;
    history.push({ t: now, temp: tile.temp, pressure: tile.pressure||0 });
    if(meta) meta.lastSampleAt = now;
    while(history.length && history[0].t < cutoff){ history.shift(); }
    if(history.length>200) history.shift();
  }
}
