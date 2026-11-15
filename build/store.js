/* ===================== storage adapter (Supabase) =====================
   Same interface as the claude.ai version: watchDoc, watchCol, set, update, del, lock, wipe.
   Data lives in one table (docs) per household; live updates come over Supabase Realtime. */
const Store = {
  sb:null, user:null, hid:null, cache:{}, cbs:{}, chan:null, ready:false,
  async client(){
    if (this.sb) return this.sb;
    const C = window.BUDGET_CONFIG || {};
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm');
    this.sb = createClient(C.supabaseUrl, C.supabaseKey, { auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true } });
    return this.sb;
  },
  async init(){
    const sb = await this.client();
    const { data:{ session } } = await sb.auth.getSession();
    if (!session) return null;
    this.user = session.user;
    const { data: hid, error } = await sb.rpc('bootstrap');
    if (error) return { error: error.message };
    this.hid = hid;
    sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') location.reload(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.resync(); });
    return { me: this.user.id, readOnly: false };
  },
  key(path){ const i = path.indexOf('/'); return [path.slice(0,i), path.slice(i+1)]; },
  emit(coll){
    for (const cb of (this.cbs[coll]||[])) cb(coll === 'config' ? (this.cache.config && this.cache.config.main ? {...this.cache.config.main} : null) : {...(this.cache[coll]||{})}, true);
  },
  live(){
    if (this.chan) return;
    this.chan = this.sb.channel('docs-'+this.hid)
      .on('postgres_changes', { event:'*', schema:'public', table:'docs', filter:'household_id=eq.'+this.hid }, p => {
        const row = p.eventType === 'DELETE' ? p.old : p.new;
        if (!row || (row.household_id && row.household_id !== this.hid)) return;
        const c = this.cache[row.coll] || (this.cache[row.coll] = {});
        if (p.eventType === 'DELETE') delete c[row.id]; else c[row.id] = row.data;
        this.emit(row.coll);
      })
      .subscribe(status => { if (status === 'SUBSCRIBED' && this.ready) this.resync(); });
  },
  async fetchColl(coll){
    const out = {}; let from = 0;
    for (;;) {
      const { data, error } = await this.sb.from('docs').select('id,data').eq('household_id', this.hid).eq('coll', coll).range(from, from+999);
      if (error) throw { code:'unavailable', message:error.message };
      for (const r of data) out[r.id] = r.data;
      if (data.length < 1000) break; from += 1000;
    }
    this.cache[coll] = out; return out;
  },
  async resync(){
    try { for (const coll of Object.keys(this.cbs)) { await this.fetchColl(coll); this.emit(coll); } } catch(e){}
    if (typeof S !== 'undefined' && S.cfg) { S.catchupDone = false; maybeReady(); }
  },
  watch(coll, cb, err){
    (this.cbs[coll] || (this.cbs[coll] = [])).push(cb);
    this.live();
    this.fetchColl(coll).then(() => { this.ready = true; this.emit(coll); }).catch(e => err && err(e));
    return () => { this.cbs[coll] = (this.cbs[coll]||[]).filter(f => f !== cb); };
  },
  watchDoc(path, cb, err){ return this.watch(this.key(path)[0], cb, err); },
  watchCol(name, cb, err){ return this.watch(name, cb, err); },
  async set(path, data){
    const [coll, id] = this.key(path);
    (this.cache[coll] || (this.cache[coll] = {}))[id] = data; this.emit(coll);
    const { error } = await this.sb.from('docs').upsert({ household_id:this.hid, coll, id, data, updated_at:new Date().toISOString() });
    if (error) throw { code:'unavailable', message:error.message };
  },
  async update(path, patch){
    const [coll, id] = this.key(path);
    const c = this.cache[coll] || (this.cache[coll] = {});
    if (c[id]) { c[id] = { ...c[id], ...patch }; this.emit(coll); }
    const { error } = await this.sb.rpc('doc_update', { hid:this.hid, c:coll, i:id, patch });
    if (error) throw { code: error.code === 'P0002' ? 'invalid_argument' : 'unavailable', message:error.message };
  },
  async del(path){
    const [coll, id] = this.key(path);
    if (this.cache[coll]) { delete this.cache[coll][id]; this.emit(coll); }
    const { error } = await this.sb.from('docs').delete().eq('household_id', this.hid).eq('coll', coll).eq('id', id);
    if (error) throw { code:'unavailable', message:error.message };
  },
  async lock(name, holder, ttlMs){
    const { data, error } = await this.sb.rpc('try_lock', { hid:this.hid, lname:name, who:holder, ttl_ms:ttlMs });
    return !error && data === true;
  },
  async wipe(onProgress){
    const { error } = await this.sb.from('docs').delete().eq('household_id', this.hid);
    if (error) throw { code:'unavailable', message:error.message };
    this.cache = {}; for (const k of Object.keys(this.cbs)) this.emit(k); onProgress && onProgress();
  },
  fn(name, body){ return this.sb.functions.invoke(name, { body: { hid:this.hid, ...body } }); }
};
