(function(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SolderMapAssembly = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  const natural = new Intl.Collator("ru", {numeric:true, sensitivity:"base"});
  const types = {R:"Резисторы", C:"Конденсаторы", L:"Катушки", D:"Диоды", Q:"Транзисторы", U:"Микросхемы", IC:"Микросхемы", J:"Разъёмы", X:"Разъёмы", LED:"Светодиоды"};
  function key(c) { return `${c.side}:${c.ref}`; }
  function text(value) { return String(value ?? "").toLowerCase().replace(/ё/g,"е").replace(/[µμ]/g,"u").replace(/ω/g,"ом").replace(/\s+/g," ").trim(); }
  function kind(c) { return String(c.ref || "").toUpperCase().match(/^[A-Z]+/)?.[0] || ""; }
  // Explicit units distinguish the electrical value from power, package and tolerance.
  const resistorValue = /(^|[^\p{L}\p{N}.,])((?:\d{1,3}(?: \d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?|[.,]\d+)\s*(?:[кkmм]\s*(?:ом|ohms?)?|ом|ohms?|r)|\d*[rкkmм]\d+)(?=$|[^\p{L}\p{N}])/gu;
  const capacitorValue = /(^|[^\p{L}\p{N}.,])((?:\d{1,3}(?: \d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?|[.,]\d+)\s*(?:мкф|uf|нф|nf|пф|pf|мф|mf|u|n|p)|\d*[unp]\d+)(?=$|[^\p{L}\p{N}])/gu;
  function readNominalToken(input, type, allowBare) {
    const raw = text(input).replace(/\s+/g,"").replace(/,/g,".");
    let value = null;
    if (type === "R") {
      const embedded = raw.match(/^(\d*)([rкkmм])(\d+)$/);
      const ordinary = raw.match(/^(\d+(?:\.\d*)?|\.\d+)([кk](?:ом|ohms?)?|[мm](?:ом|ohms?)?|ом|ohms?|r)?$/);
      const scale = unit => /^[кk]/.test(unit) ? 1e3 : /^[мm]/.test(unit) ? 1e6 : 1;
      if (embedded) value = Number((embedded[1] || "0")+"."+embedded[3]) * scale(embedded[2]);
      else if (ordinary && (allowBare || ordinary[2])) value = Number(ordinary[1]) * scale(ordinary[2] || "");
    } else if (type === "C") {
      const scales = {пф:1,pf:1,p:1,нф:1e3,nf:1e3,n:1e3,мкф:1e6,uf:1e6,u:1e6,мф:1e9,mf:1e9};
      const ordinary = raw.match(/^(\d+(?:\.\d*)?|\.\d+)(пф|pf|p|нф|nf|n|мкф|uf|u|мф|mf)$/);
      const embedded = raw.match(/^(\d*)([unp])(\d+)$/);
      if (ordinary) value = Number(ordinary[1]) * scales[ordinary[2]];
      else if (embedded) value = Number((embedded[1] || "0")+"."+embedded[3]) * scales[embedded[2]];
    }
    return value !== null && Number.isFinite(value) ? Number(value.toPrecision(12)) : null;
  }
  function findNominal(input, type, allowBare=false) {
    if (!["R","C"].includes(type)) return null;
    const raw = text(input), whole = readNominalToken(raw,type,allowBare);
    if (whole !== null) return {type,value:whole,start:0,end:raw.length,complete:true};
    const pattern = type === "R" ? resistorValue : capacitorValue;
    const candidates = [...raw.matchAll(pattern)].map(match => ({
      type,value:readNominalToken(match[2],type,false),
      start:match.index+match[1].length,end:match.index+match[0].length,complete:false
    })).filter(item => item.value !== null);
    // Do not guess when a description contains several different electrical values.
    return new Set(candidates.map(item=>item.value)).size === 1 ? candidates[0] : null;
  }
  function nominal(c) {
    const type = kind(c);
    const raw = text(c.value).replace(/\s+/g, "").replace(/,/g,".");
    const measurement = findNominal(c.value,type,true);
    const value = measurement?.value ?? null;
    let label = String(c.value || "").trim() || "Без номинала";
    if (value !== null && Number.isFinite(value)) {
      const choices = type === "R" ? [[1e6,"МОм"],[1e3,"кОм"],[1,"Ом"]] : [[1e9,"мФ"],[1e6,"мкФ"],[1e3,"нФ"],[1,"пФ"]];
      const [scale, unit] = choices.find(([s]) => value >= s) || choices.at(-1);
      label = `${Number((value / scale).toPrecision(12)).toLocaleString("ru-RU", {maximumFractionDigits:9})} ${unit}`;
    }
    return {key:`${type}:${value === null ? raw : value}`, label, type, typeLabel:types[type] || type || "Компоненты",
      measurement,description:measurement&&!measurement.complete?String(c.value).trim():""};
  }
  function matchesSearch(c, query) {
    const q = text(query);
    if (!q) return true;
    const tokens = q.split(/[\s,;]+/).filter(Boolean);
    const ref = text(c.ref);
    const isReference = token => {
      const match=token.match(/^([a-z]+)\d+$/);
      return !!match && (!!types[match[1].toUpperCase()] || ["T","B",kind(c)].includes(match[1].toUpperCase()));
    };
    if (tokens.every(isReference)) return tokens.some(t => ref === t);
    const n = nominal(c);
    const haystack = text(`${c.ref} ${c.value} ${n.label} ${n.typeLabel} ${c.type || ""} ${c.group || ""} ${c.note || ""}`);
    // A reference such as R2 in a combined query is not the resistor notation 0R2.
    const references = tokens.filter(isReference);
    const nominalQuery = text(q.replace(/(^|[\s,;])([a-z]+\d+)(?=$|[\s,;])/g,(match,separator,reference)=>isReference(reference)?separator:match));
    const electrical = [findNominal(nominalQuery,"R"),findNominal(nominalQuery,"C")].filter(Boolean);
    if (electrical.length) {
      if (electrical.length !== 1) return false;
      if (references.length && !references.includes(ref)) return false;
      const requested = electrical[0];
      if (["R","C"].includes(n.type) && n.type !== requested.type) return false;
      const actual = n.measurement || findNominal(c.value,requested.type);
      if (!actual || actual.type !== requested.type || actual.value !== requested.value) return false;
      const remainder = (nominalQuery.slice(0,requested.start)+" "+nominalQuery.slice(requested.end)).split(/[\s,;]+/).filter(Boolean);
      return remainder.every(token => haystack.includes(token));
    }
    const compact = haystack.replace(/\s+/g, "");
    if (compact.includes(q.replace(/\s+/g,""))) return true;
    const queryNominal = nominal({...c, value:q});
    if (queryNominal.key === n.key) return true;
    return tokens.every(token => haystack.includes(token));
  }
  function visible(project, filters = {}) {
    return project.components.filter(c => c.side === filters.side
      && (!filters.stage || c.stage === filters.stage)
      && (!filters.group || c.group === filters.group)
      && (!filters.nominal || nominal(c).key === filters.nominal)
      && (filters.status !== "pending" || !project.doneMap[key(c)])
      && (filters.status !== "done" || !!project.doneMap[key(c)])
      && matchesSearch(c, filters.query));
  }
  function batches(components, doneMap = {}, sort = "remaining") {
    const groups = new Map();
    components.forEach(c => {
      const n = nominal(c);
      if (!groups.has(n.key)) groups.set(n.key, {...n, components:[], total:0, remaining:0});
      const group = groups.get(n.key);
      group.components.push(c); group.total += 1;
      if (!doneMap[key(c)]) group.remaining += 1;
    });
    return [...groups.values()].sort((a,b) => (sort === "name" ? 0 : sort === "total" ? b.total-a.total : b.remaining-a.remaining) || natural.compare(a.typeLabel,b.typeLabel) || natural.compare(a.label,b.label));
  }
  function normalizeProject(data, name = "Новый проект") {
    const source = data && typeof data === "object" ? data : {};
    const images = {}, imageSizes = {};
    for (const side of ["TOP","BOTTOM"]) {
      const image = source.images?.[side];
      const file = typeof image === "string" ? image : image?.file;
      images[side] = typeof file === "string" && file ? {file} : null;
      const size = source.imageSizes?.[side];
      imageSizes[side] = {w:Number(size?.w) > 0 ? Number(size.w) : 1024, h:Number(size?.h) > 0 ? Number(size.h) : 768};
    }
    const used = new Set();
    const components = (Array.isArray(source.components) ? source.components : []).filter(c => c && typeof c === "object").map((c,i) => {
      const side = c.side === "BOTTOM" ? "BOTTOM" : "TOP";
      const base = String(c.ref || `T${i+1}`).trim(); let ref = base; let suffix=2;
      while (used.has(`${side}:${ref.toUpperCase()}`)) ref = `${base}_${suffix++}`;
      used.add(`${side}:${ref.toUpperCase()}`);
      return {ref,side,value:String(c.value || ""),type:String(c.type || ""),stage:String(c.stage || ""),group:String(c.group || ""),note:String(c.note || ""),x:Math.max(0,Number(c.x)||0),y:Math.max(0,Number(c.y)||0),w:Math.max(1,Number(c.w)||40),h:Math.max(1,Number(c.h)||28),...(c.unplaced ? {unplaced:true} : {})};
    });
    const stages = new Map();
    (Array.isArray(source.stages) ? source.stages : []).forEach((s,i) => {
      const item = typeof s === "object" && s ? s : {id:String(s),name:String(s)};
      if (item.id) stages.set(String(item.id), {id:String(item.id),name:String(item.name || item.id),order:Number(item.order)||i+1});
    });
    components.filter(c=>c.stage).forEach(c=>{if(!stages.has(c.stage))stages.set(c.stage,{id:c.stage,name:c.stage,order:stages.size+1});});
    return {version:4,name:String(source.name || name),images,imageSizes,components,stages:[...stages.values()].sort((a,b)=>a.order-b.order),groups:[...new Set([...(Array.isArray(source.groups)?source.groups:[]),...components.map(c=>c.group)].filter(x=>typeof x === "string"&&x))].sort(natural.compare),doneMap:Object.fromEntries(components.filter(c=>source.doneMap?.[key(c)]===true).map(c=>[key(c),true]))};
  }
  function nextRef(components, side) {
    const refs = new Set(components.filter(c=>c.side===side).map(c=>String(c.ref).toUpperCase()));
    const prefix=side==="TOP"?"T":"B"; let index=1;
    while(refs.has(`${prefix}${index}`))index++;
    return `${prefix}${index}`;
  }
  function zoomAt(view, next, anchor, scroll) {
    const scale=Math.max(0.05,Math.min(8,next));
    return {scale,left:(scroll.left+anchor.x)/view.scale*scale-anchor.x,top:(scroll.top+anchor.y)/view.scale*scale-anchor.y};
  }
  return Object.freeze({key,text,kind,nominal,matchesSearch,visible,batches,normalizeProject,nextRef,zoomAt,natural});
});
