"use strict";
const A = window.SolderMapAssembly;
const $ = id => document.getElementById(id);
const copy = value => JSON.parse(JSON.stringify(value));
const state = {
  project:null, folder:null, side:"TOP", mode:"solder", tab:"batches", selected:null,
  filters:{query:"",status:"all",stage:"",group:"",nominal:""}, sort:"remaining",
  scale:1, undo:[], redo:[], dirty:false, revision:0, saveChain:Promise.resolve(),
  imageToken:0, drawing:false, placeTarget:null, space:false
};
const browser = {
  directory:null, listing:null, history:[], position:-1, selected:new Set(), anchor:null,
  clipboard:null, mode:"details", sort:"name", ascending:true, purpose:"browse", side:null,
  token:0, places:[], resolve:null
};
let saveTimer, toastTimer, promptResolve, interaction, contextHost;
function node(tag, className, text) {
  const el=document.createElement(tag);
  if(className)el.className=className;
  if(text!==undefined)el.textContent=text;
  return el;
}
function button(text, action, className) {
  const el=node("button",className,text); el.type="button"; el.addEventListener("click",action); return el;
}
function toast(message,error=false) {
  clearTimeout(toastTimer);
  $("toast").textContent=String(message).replace(/^Error invoking remote method '[^']+': Error: /,"");
  $("toast").className="toast"+(error?" error":""); $("toast").hidden=false;
  toastTimer=setTimeout(()=>{$("toast").hidden=true;},error?6500:3200);
}
function run(callback) {
  return async (...args) => { try { await callback(...args); } catch(error) { toast(error.message,true); } };
}
function ask(title,message="",initial=null,ok="OK") {
  if(promptResolve)promptResolve(null);
  $("promptTitle").textContent=title; $("promptMessage").textContent=message;
  $("promptMessage").hidden=!message; $("promptInput").hidden=initial===null;
  $("promptInput").value=initial===null?"":initial; $("promptOk").textContent=ok;
  $("promptDialog").showModal();
  setTimeout(()=>{const target=initial===null?$("promptOk"):$("promptInput");target.focus();if(initial!==null)target.select();},0);
  return new Promise(resolve=>{promptResolve=resolve;});
}
function answerPrompt(ok) {
  const result=ok?($("promptInput").hidden?true:$("promptInput").value.trim()):null;
  $("promptDialog").close(); const resolve=promptResolve;promptResolve=null;if(resolve)resolve(result);
}
function selectedComponent() { return state.project?.components.find(c=>A.key(c)===state.selected); }
function filtered(ignoreNominal=false) {
  return state.project?A.visible(state.project,{...state.filters,nominal:ignoreNominal?"":state.filters.nominal,side:state.side}):[];
}
function currentBatch() {
  if(!state.filters.nominal||!state.project)return null;
  return A.batches(state.project.components.filter(c=>c.side===state.side),state.project.doneMap).find(b=>b.key===state.filters.nominal);
}
function remember() {
  state.undo.push(copy(state.project)); if(state.undo.length>80)state.undo.shift(); state.redo=[];
}
function changed() {
  state.project=A.normalizeProject(state.project);
  state.dirty=true;state.revision++;render();
  $("saveState").textContent="Есть изменения";
  clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveProject().catch(error=>toast(error.message,true));},450);
}
function mutate(callback) { if(!state.project)return;remember();callback();changed(); }
async function saveProject() {
  clearTimeout(saveTimer);
  if(!state.project||!state.dirty)return state.saveChain;
  const folder=state.folder, snapshot=copy(state.project),revision=state.revision;
  $("saveState").textContent="Сохраняется…";
  const next=state.saveChain.catch(()=>{}).then(()=>window.projectApi.writeProject(folder,snapshot));
  state.saveChain=next;
  try {
    await next;
    if(state.folder===folder&&state.revision===revision){state.dirty=false;$("saveState").textContent="Сохранено";}
  } catch(error) { $("saveState").textContent="Не сохранено";throw error; }
}
async function closeApp() { await saveProject();window.windowControls.close(); }
async function showProjects() {
  const projects=await window.projectApi.listProjects(),list=$("projectsList");list.replaceChildren();
  if(!projects.length)list.append(node("p","empty-note","Пока нет проектов. Создайте карту и загрузите изображения платы."));
  projects.forEach(project=>{
    const card=button("",run(()=>openProject(project.path)),"project-card");
    card.append(node("span","","▧"));
    const body=node("span","row-body");body.append(node("span","row-title",project.name),node("span","row-meta",new Date(project.updatedAt).toLocaleString("ru-RU")),node("span","row-meta",project.path));
    card.append(body);list.append(card);
  });
  if(!$("projectsDialog").open)$("projectsDialog").showModal();
}
async function newProject() {
  const name=await ask("Новый проект","Название карты пайки","Новая плата","Создать");if(!name)return;
  await saveProject();const folder=await window.projectApi.createProjectFolder(name);
  state.project=A.normalizeProject({name});state.folder=folder.path;resetWorkspace();
  state.dirty=true;state.revision++;await saveProject();$("projectsDialog").close();
  await loadBoard();render();toast("Проект создан. Добавьте изображение платы.");
}
function resetWorkspace() {
  state.side="TOP";state.selected=null;state.undo=[];state.redo=[];state.filters={query:"",status:"all",stage:"",group:"",nominal:""};
  state.mode="solder";state.tab="batches";state.drawing=false;state.placeTarget=null;state.dirty=false;state.scale=1;state.imageToken++;
}
async function openProject(folder) {
  await saveProject();const data=await window.projectApi.readProject(folder);
  state.project=A.normalizeProject(data);state.folder=folder;resetWorkspace();
  // Save the supported schema, preserving the image layout and soldering progress.
  state.dirty=true;state.revision++;await saveProject();
  $("projectsDialog").close();await loadBoard();render();
}
async function setSide(side) {
  if(state.side===side)return;
  state.side=side;state.selected=null;state.filters.nominal="";state.drawing=false;state.placeTarget=null;
  await loadBoard();render();
}
function imageInfo(url) {
  return new Promise((resolve,reject)=>{
    const image=new Image();image.onload=()=>resolve({w:image.naturalWidth,h:image.naturalHeight});image.onerror=()=>reject(new Error("Не удалось открыть изображение."));image.src=url;
  });
}
async function loadBoard() {
  const token=++state.imageToken,side=state.side,file=state.project?.images[side]?.file;
  $("boardSizer").hidden=true;$("boardEmpty").hidden=false;
  if(!file)return;
  try {
    const url=await window.projectApi.imageUrl(state.folder,file);await imageInfo(url);
    if(token!==state.imageToken)return;
    $("boardImage").src=url;$("boardSizer").hidden=false;$("boardEmpty").hidden=true;
    updateBoardSize();fitBoard();
  } catch(error){toast(error.message,true);}
}
async function importImage(item,side) {
  if(!state.project)return;
  const size=await imageInfo(item.url),previous=state.project.imageSizes[side];
  const saved=await window.projectApi.copyImage(state.folder,item.path,side);
  mutate(()=>{
    state.project.images[side]={file:saved.file};state.project.imageSizes[side]=size;
    state.project.components.filter(c=>c.side===side).forEach(c=>{
      c.x*=size.w/previous.w;c.w*=size.w/previous.w;c.y*=size.h/previous.h;c.h*=size.h/previous.h;
    });
  });
  await loadBoard();toast("Изображение "+side+" добавлено.");
}
function updateBoardSize() {
  const size=state.project?.imageSizes[state.side]||{w:1024,h:768};
  $("boardCanvas").style.width=size.w+"px";$("boardCanvas").style.height=size.h+"px";
  $("boardCanvas").style.transform="scale("+state.scale+")";
  $("boardSizer").style.width=size.w*state.scale+"px";$("boardSizer").style.height=size.h*state.scale+"px";
  $("zoomLabel").textContent=Math.round(state.scale*100)+"%";$("zoomSlider").value=Math.round(state.scale*100);
}
function setZoom(next,anchor) {
  const viewport=$("boardViewport");anchor=anchor||{x:viewport.clientWidth/2,y:viewport.clientHeight/2};
  const zoom=A.zoomAt({scale:state.scale},next,anchor,{left:viewport.scrollLeft-32,top:viewport.scrollTop-32});
  state.scale=zoom.scale;updateBoardSize();
  viewport.scrollLeft=zoom.left+32;viewport.scrollTop=zoom.top+32;
}
function fitBoard() {
  const size=state.project?.imageSizes[state.side];if(!size)return;
  const viewport=$("boardViewport");
  state.scale=Math.max(.05,Math.min((viewport.clientWidth-64)/size.w,(viewport.clientHeight-64)/size.h,2));
  updateBoardSize();viewport.scrollLeft=0;viewport.scrollTop=0;
}
function syncSelect(id,entries,value,empty) {
  const select=$(id);select.replaceChildren();
  entries=[["",empty],...entries];
  entries.forEach(([key,label])=>{const option=node("option","",label);option.value=key;select.append(option);});
  select.value=value;if(select.value!==value)state.filters[id==="stageFilter"?"stage":"group"]="";
}
function render() {
  $("projectName").textContent=state.project?.name||"Откройте проект";
  $("saveButton").disabled=!state.project;$("undoButton").disabled=!state.undo.length;$("redoButton").disabled=!state.redo.length;
  $("topButton").classList.toggle("active",state.side==="TOP");$("bottomButton").classList.toggle("active",state.side==="BOTTOM");
  $("solderMode").classList.toggle("active",state.mode==="solder");$("editMode").classList.toggle("active",state.mode==="edit");
  $("addComponent").hidden=state.mode!=="edit";$("editHelp").hidden=state.mode!=="edit";
  $("addComponent").textContent=state.drawing?"Отменить рисование":"＋ Компонент";
  $("loadImage").disabled=!state.project;$("addComponent").disabled=!state.project?.images[state.side];
  $("boardViewport").classList.toggle("drawing",state.drawing);
  $("searchInput").value=state.filters.query;$("statusFilter").value=state.filters.status;
  syncSelect("stageFilter",(state.project?.stages||[]).map(s=>[s.id,s.name]),state.filters.stage,"Все этапы");
  syncSelect("groupFilter",(state.project?.groups||[]).map(s=>[s,s]),state.filters.group,"Все группы");
  $("stageSuggestions").replaceChildren(...(state.project?.stages||[]).map(s=>{const el=node("option");el.value=s.id;return el;}));
  $("groupSuggestions").replaceChildren(...(state.project?.groups||[]).map(s=>{const el=node("option");el.value=s;return el;}));
  $("batchesTab").classList.toggle("active",state.tab==="batches");$("componentsTab").classList.toggle("active",state.tab==="components");
  $("batchSort").hidden=state.tab!=="batches";$("listHint").textContent=state.tab==="batches"?"Начните с большой партии":"Обозначение · номинал";
  const batch=currentBatch();$("nominalChip").hidden=!batch;
  if(batch)$("nominalChip").firstElementChild.textContent=batch.typeLabel+" · "+batch.label;
  renderList();renderBoard();renderInspector();
}
function renderList() {
  const list=$("componentList"),components=filtered();list.replaceChildren();
  if(!state.project){list.append(node("p","empty-note","Откройте проект, чтобы увидеть компоненты."));return;}
  if(!components.length){list.append(node("p","empty-note",state.project.components.some(c=>c.side===state.side)?"Ничего не найдено. Измените запрос или сбросьте фильтры.":"На этой стороне ещё нет компонентов. Добавьте их в режиме «Разметка»."));return;}
  if(state.tab==="batches") {
    A.batches(components,state.project.doneMap,state.sort).forEach(batch=>{
      const row=button("",()=>chooseBatch(batch),"batch-row"+(state.filters.nominal===batch.key?" active":""));
      const body=node("span","row-body");
      body.append(node("span","row-title",batch.label),node("span","row-meta",batch.typeLabel+" · "+batch.remaining+" осталось из "+batch.total));
      row.append(body,node("span","batch-count"+(!batch.remaining?" complete":""),batch.remaining?String(batch.remaining):"✓"));
      row.addEventListener("contextmenu",event=>{event.preventDefault();showContext(event,[{label:"Показать этот номинал",action:()=>chooseBatch(batch)}]);});list.append(row);
    });
  } else {
    components.sort((a,b)=>A.natural.compare(a.ref,b.ref)).forEach(c=>{
      const row=button("",()=>selectComponent(c,true),"component-row"+(state.selected===A.key(c)?" active":""));
      const body=node("span","row-body");body.append(node("strong","",c.ref),node("span","row-meta",A.nominal(c).label));
      const done=!!state.project.doneMap[A.key(c)];row.title=(done?"Припаян":"Ожидает пайки")+(c.unplaced?" · область не задана":"");
      row.append(node("i","status-dot"+(done?" done":"")),body);
      row.addEventListener("contextmenu",event=>componentContext(event,c));list.append(row);
    });
  }
}
function renderBoard() {
  const overlays=$("overlays");overlays.replaceChildren();if(!state.project)return;
  const visible=new Set(filtered().map(A.key)),hasNominal=!!state.filters.nominal;
  state.project.components.filter(c=>c.side===state.side&&!c.unplaced).forEach(c=>{
    const box=node("div","component-box");box.dataset.key=A.key(c);
    box.classList.toggle("done",!!state.project.doneMap[A.key(c)]);
    box.classList.toggle("selected",state.selected===A.key(c));
    box.classList.toggle("batch-match",hasNominal&&visible.has(A.key(c)));
    box.classList.toggle("dimmed",hasNominal&&!visible.has(A.key(c)));
    box.classList.toggle("filtered-out",!hasNominal&&!visible.has(A.key(c)));
    Object.assign(box.style,{left:c.x+"px",top:c.y+"px",width:c.w+"px",height:c.h+"px"});
    box.title=c.ref+" · "+A.nominal(c).label+" · "+(state.project.doneMap[A.key(c)]?"Припаян":"Ожидает пайки");
    box.append(node("span","",c.ref));
    if(state.mode==="edit"&&state.selected===A.key(c))box.append(node("i","resize-handle"));
    box.addEventListener("click",event=>{event.stopPropagation();if(!interaction?.moved)selectComponent(c);});
    box.addEventListener("contextmenu",event=>componentContext(event,c));
    overlays.append(box);
  });
}
function renderInspector() {
  const c=selectedComponent(),batch=currentBatch();
  $("inspectorEmpty").hidden=!!c;$("inspectorContent").hidden=!c;$("editorFields").hidden=state.mode!=="edit";
  $("placeComponent").hidden=!c||state.mode!=="edit";
  $("placeComponent").disabled=!state.project?.images[state.side];
  if(c) {
    const done=!!state.project.doneMap[A.key(c)];
    $("selectedRef").textContent=c.ref;$("selectedNominal").textContent=A.nominal(c).label;
    $("selectedStatus").textContent=done?"✓ Припаян":"● Ожидает пайки";$("selectedStatus").className="status-label"+(done?" done":"");
    $("toggleSolder").textContent=done?"Снять отметку пайки":"Отметить припаянным";
    $("selectedNote").textContent=c.note||"";$("selectedNote").hidden=!c.note;
    for(const [field,name] of [["editRef","ref"],["editValue","value"],["editType","type"],["editStage","stage"],["editGroup","group"],["editNote","note"]])$(field).value=c[name]||"";
  }
  $("batchActions").hidden=!batch;
  if(batch) {
    $("batchTitle").textContent=batch.typeLabel+" · "+batch.label;
    $("batchDetail").textContent=state.side+" · "+batch.remaining+" осталось из "+batch.total+"\n"+batch.components.map(c=>c.ref).sort(A.natural.compare).join(", ");
    $("markBatch").disabled=!batch.remaining;
  }
}
function selectComponent(c,focus=false) {
  state.selected=A.key(c);renderList();renderInspector();renderBoard();
  if(focus&&!c.unplaced)focusComponent(c);
}
function focusComponent(c) {
  const viewport=$("boardViewport");
  viewport.scrollLeft=32+(c.x+c.w/2)*state.scale-viewport.clientWidth/2;
  viewport.scrollTop=32+(c.y+c.h/2)*state.scale-viewport.clientHeight/2;
}
function chooseBatch(batch) {
  state.filters.nominal=batch.key;state.tab="components";
  const first=batch.components.find(c=>!state.project.doneMap[A.key(c)])||batch.components[0];
  state.selected=first?A.key(first):null;render();
  if(first&&!first.unplaced)focusComponent(first);
}
function sameNominal(c=selectedComponent()) {
  if(!c)return;
  state.filters={query:"",status:"all",stage:"",group:"",nominal:A.nominal(c).key};
  chooseBatch(A.batches(state.project.components.filter(item=>item.side===state.side),state.project.doneMap).find(b=>b.key===state.filters.nominal));
  state.selected=A.key(c);render();focusComponent(c);
}
function clearFilters() {
  state.filters={query:"",status:"all",stage:"",group:"",nominal:""};state.tab="batches";render();
}
function toggleSolder(c=selectedComponent()) {
  if(!c)return;
  const done=!state.project.doneMap[A.key(c)];
  mutate(()=>{if(done)state.project.doneMap[A.key(c)]=true;else delete state.project.doneMap[A.key(c)];});
}
function componentContext(event,c) {
  event.preventDefault();event.stopPropagation();selectComponent(c);
  showContext(event,[
    {label:"Показать такой же номинал · "+state.side,action:()=>sameNominal(c)},
    {label:state.project.doneMap[A.key(c)]?"Снять отметку пайки":"Отметить припаянным",action:()=>toggleSolder(c)},
    {label:"Перейти к компоненту",action:()=>focusComponent(c)},
    ...(state.mode==="edit"?[{label:"Удалить компонент",action:deleteSelected}]:[])
  ]);
}
function showContext(event,items) {
  const menu=$("contextMenu");menu.replaceChildren();
  const inFiles=$("filesDialog").open;contextHost=inFiles?$("filesDialog"):document.body;
  contextHost.append(menu);
  items.forEach(item=>{if(!item){menu.append(node("hr"));return;}const el=button(item.label,run(async()=>{hideContext();await item.action();}));el.disabled=!!item.disabled;menu.append(el);});
  menu.hidden=false;
  const rect=menu.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(event.clientX,innerWidth-rect.width-8))+"px";menu.style.top=Math.max(8,Math.min(event.clientY,innerHeight-rect.height-8))+"px";
}
function hideContext() { $("contextMenu").hidden=true; }
async function applyComponent() {
  const c=selectedComponent();if(!c)return;
  const ref=$("editRef").value.trim();
  if(!ref)throw new Error("Введите обозначение.");
  if(state.project.components.some(other=>other!==c&&other.side===c.side&&other.ref.toUpperCase()===ref.toUpperCase()))throw new Error("Такое обозначение уже есть на этой стороне.");
  mutate(()=>{
    const old=A.key(c),done=!!state.project.doneMap[old];
    for(const [id,field] of [["editRef","ref"],["editValue","value"],["editType","type"],["editStage","stage"],["editGroup","group"],["editNote","note"]])c[field]=$(id).value.trim();
    delete state.project.doneMap[old];if(done)state.project.doneMap[A.key(c)]=true;state.selected=A.key(c);
  });
}
async function deleteSelected() {
  const c=selectedComponent();if(!c)return;
  if(!await ask("Удалить "+c.ref+"?","Действие можно отменить через Ctrl+Z.",null,"Удалить"))return;
  mutate(()=>{state.project.components=state.project.components.filter(item=>item!==c);delete state.project.doneMap[A.key(c)];state.selected=null;});
}
async function historyAction(redo=false) {
  const from=redo?state.redo:state.undo,to=redo?state.undo:state.redo;if(!from.length)return;
  const previous=JSON.stringify([state.project.images,state.project.imageSizes]);
  to.push(copy(state.project));state.project=from.pop();state.drawing=false;state.placeTarget=null;changed();
  if(previous!==JSON.stringify([state.project.images,state.project.imageSizes]))await loadBoard();
}
function boardPoint(event) {
  const rect=$("boardCanvas").getBoundingClientRect(),size=state.project.imageSizes[state.side];
  return {x:Math.max(0,Math.min(size.w,(event.clientX-rect.left)/state.scale)),y:Math.max(0,Math.min(size.h,(event.clientY-rect.top)/state.scale))};
}
function beginBoard(event) {
  if(event.button===2)return;
  const viewport=$("boardViewport");
  if(event.button===1||state.space){
    event.preventDefault();interaction={type:"pan",x:event.clientX,y:event.clientY,left:viewport.scrollLeft,top:viewport.scrollTop,pointer:event.pointerId,moved:false};viewport.setPointerCapture(event.pointerId);viewport.classList.add("panning");return;
  }
  if(!state.project?.images[state.side]||event.button!==0)return;
  const box=event.target.closest(".component-box"),point=boardPoint(event);
  if(state.drawing) {
    interaction={type:"draw",start:point,pointer:event.pointerId,moved:false};$("drawRectangle").hidden=false;
  } else if(box&&state.mode==="edit") {
    const c=state.project.components.find(c=>A.key(c)===box.dataset.key);
    const resize=event.target.classList.contains("resize-handle");
    selectComponent(c);interaction={type:resize?"resize":"move",start:point,original:{x:c.x,y:c.y,w:c.w,h:c.h},component:c,before:copy(state.project),pointer:event.pointerId,moved:false};
  } else return;
  event.preventDefault();viewport.setPointerCapture(event.pointerId);
}
function moveBoard(event) {
  if(!interaction||event.pointerId!==interaction.pointer)return;
  const action=interaction;
  if(action.type==="pan") {
    $("boardViewport").scrollLeft=action.left+action.x-event.clientX;$("boardViewport").scrollTop=action.top+action.y-event.clientY;
    action.moved=true;return;
  }
  const point=boardPoint(event),dx=point.x-action.start.x,dy=point.y-action.start.y;
  action.moved=action.moved||Math.abs(dx)+Math.abs(dy)>2/state.scale;
  if(action.type==="draw"){
    action.rectangle={x:Math.min(point.x,action.start.x),y:Math.min(point.y,action.start.y),w:Math.abs(dx),h:Math.abs(dy)};
    Object.assign($("drawRectangle").style,{left:action.rectangle.x+"px",top:action.rectangle.y+"px",width:action.rectangle.w+"px",height:action.rectangle.h+"px"});return;
  }
  const c=action.component,o=action.original,size=state.project.imageSizes[state.side];
  if(action.type==="move"){c.x=Math.max(0,Math.min(size.w-c.w,o.x+dx));c.y=Math.max(0,Math.min(size.h-c.h,o.y+dy));}
  else{c.w=Math.max(3,Math.min(size.w-c.x,o.w+dx));c.h=Math.max(3,Math.min(size.h-c.y,o.h+dy));}
  const box=[...$("overlays").children].find(el=>el.dataset.key===A.key(c));
  if(box)Object.assign(box.style,{left:c.x+"px",top:c.y+"px",width:c.w+"px",height:c.h+"px"});
}
function endBoard(event) {
  if(!interaction||interaction.pointer!==event.pointerId)return;
  const action=interaction;interaction=null;$("boardViewport").classList.remove("panning");
  if($("boardViewport").hasPointerCapture(event.pointerId))$("boardViewport").releasePointerCapture(event.pointerId);
  $("drawRectangle").hidden=true;
  if(action.type==="draw") {
    const rect=action.rectangle;state.drawing=false;
    if(rect&&rect.w>=3&&rect.h>=3)mutate(()=>{
      const existing=state.project.components.find(c=>A.key(c)===state.placeTarget);
      const c=existing||{ref:A.nextRef(state.project.components,state.side),side:state.side,value:"",type:"",stage:state.filters.stage,group:state.filters.group,note:""};
      Object.assign(c,rect);delete c.unplaced;
      if(!existing)state.project.components.push(c);
      state.selected=A.key(c);state.placeTarget=null;state.filters.nominal="";state.filters.query="";state.filters.status="all";
    });
    else render();
  } else if(action.type!=="pan"&&action.moved) {
    state.undo.push(action.before);state.redo=[];changed();
  }
}

// The built-in file browser delegates operations to the isolated main process.
async function openBrowser(purpose="browse",side=null,initial=null) {
  hideContext();browser.purpose=purpose;browser.side=side;browser.selected.clear();browser.anchor=null;$("fileSearch").value="";
  $("filesTitle").textContent=purpose==="image"?"Изображение платы · "+side:purpose==="project"?"Открыть проект":"Проводник";
  $("filesPurpose").textContent=purpose==="image"?"Выберите изображение, затем нажмите «Использовать изображение».":purpose==="project"?"Откройте папку, содержащую project.json.":"Файлы и папки вашего компьютера";
  browser.places=await window.fileBrowserApi.places();$("filePlaces").replaceChildren();
  browser.places.forEach(place=>$("filePlaces").append(button(place.name,run(()=>navigateFiles(place.path)))));
  if(!$("filesDialog").open)$("filesDialog").showModal();
  await navigateFiles(initial||browser.directory||(purpose==="image"?browser.places.find(p=>p.name==="Изображения")?.path:null)||browser.places[0].path);
}
async function navigateFiles(path,history=true) {
  const token=++browser.token;const listing=await window.fileBrowserApi.list(path,$("showHidden").checked);
  if(token!==browser.token)return;
  if(browser.directory!==listing.path)$("fileSearch").value="";
  browser.directory=listing.path;browser.listing=listing;browser.selected.clear();browser.anchor=null;
  if(history&&browser.history[browser.position]!==listing.path){browser.history=browser.history.slice(0,browser.position+1);browser.history.push(listing.path);browser.position=browser.history.length-1;}
  $("fileAddress").value=listing.path;renderFiles();$("fileItems").scrollTop=0;
}
async function travelFiles(delta) {
  const position=browser.position+delta;if(position<0||position>=browser.history.length)return;
  const previous=browser.position;browser.position=position;
  try{await navigateFiles(browser.history[position],false);}catch(error){browser.position=previous;throw error;}
}
function fileItems() {
  const query=A.text($("fileSearch").value);
  return (browser.listing?.items||[]).filter(item=>!query||A.text(item.name).includes(query)).sort((a,b)=>{
    if((a.type==="folder")!==(b.type==="folder"))return a.type==="folder"?-1:1;
    const compared=browser.sort==="name"?A.natural.compare(a.name,b.name):a[browser.sort]-b[browser.sort];
    return compared*(browser.ascending?1:-1)||A.natural.compare(a.name,b.name);
  });
}
function sizeText(bytes) {
  if(bytes<1024)return bytes+" Б";if(bytes<1024*1024)return (bytes/1024).toFixed(1)+" КБ";return (bytes/1024/1024).toFixed(1)+" МБ";
}
function selectedFiles() { return (browser.listing?.items||[]).filter(item=>browser.selected.has(item.path)); }
function renderFiles() {
  const list=$("fileItems"),items=fileItems();list.replaceChildren();list.className="file-items"+(browser.mode==="tiles"?" tiles":"");
  document.querySelector(".file-columns").hidden=browser.mode==="tiles";
  $("fileView").textContent=browser.mode==="tiles"?"Таблица":"Плитки";
  if(!items.length)list.append(node("p","empty-note",$("fileSearch").value?"Ничего не найдено.":"Папка пуста."));
  items.forEach(item=>{
    const row=button("",event=>selectFile(event,item),"file-row");row.dataset.path=item.path;row.title=item.name;
    row.classList.toggle("selected",browser.selected.has(item.path));
    row.classList.toggle("cut",browser.clipboard?.mode==="move"&&browser.clipboard.paths.includes(item.path));
    const name=node("span","file-name");
    if(item.type==="image"){const img=node("img","file-thumbnail");img.src=item.url;img.alt="";img.loading="lazy";name.append(img);}
    else name.append(node("span","file-icon "+item.type,item.type==="folder"?"▰":"▤"));
    name.append(node("strong","",item.name+(item.link?" ↗":"")));
    row.append(name,node("span","file-date",new Date(item.modifiedAt).toLocaleDateString("ru-RU")+" "+new Date(item.modifiedAt).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"})),node("span","file-size",item.type==="folder"?"Папка":sizeText(item.size)));
    row.addEventListener("dblclick",run(()=>openFile(item)));
    row.addEventListener("contextmenu",event=>fileContext(event,item));
    row.draggable=!item.link;
    row.addEventListener("dragstart",event=>{
      if(!browser.selected.has(item.path)){browser.selected=new Set([item.path]);renderFileSelection();}
      event.dataTransfer.setData("application/x-soldermap-files",JSON.stringify([...browser.selected]));
      event.dataTransfer.effectAllowed="copyMove";
    });
    if(item.type==="folder"){
      row.addEventListener("dragover",event=>{event.preventDefault();event.dataTransfer.dropEffect=event.ctrlKey?"copy":"move";});
      row.addEventListener("drop",run(event=>dropFiles(event,item.path)));
    }
    list.append(row);
  });
  renderBreadcrumbs();renderFileSelection();
  [...$("filePlaces").children].forEach((el,i)=>el.classList.toggle("active",browser.places[i].path===browser.directory));
  $("fileBack").disabled=browser.position<=0;$("fileForward").disabled=browser.position>=browser.history.length-1;$("fileUp").disabled=!browser.listing?.parentPath;
}
function renderFileSelection() {
  [...$("fileItems").querySelectorAll(".file-row")].forEach(row=>row.classList.toggle("selected",browser.selected.has(row.dataset.path)));
  const selected=selectedFiles(),count=selected.length;
  for(const id of ["fileCut","fileCopy","fileDelete"])$(id).disabled=!count;
  $("fileRename").disabled=count!==1;$("filePaste").disabled=!browser.clipboard;
  $("fileStatus").textContent=count?"Выбрано: "+count+" · "+selected.map(item=>item.name).join(", "):fileItems().length+" объектов"+(browser.clipboard?" · В буфере: "+browser.clipboard.paths.length:"");
  $("filePick").hidden=browser.purpose==="browse";
  $("filePick").textContent=browser.purpose==="image"?"Использовать изображение":"Открыть проект";
  $("filePick").disabled=browser.purpose==="image"?count!==1||selected[0].type!=="image":!browser.listing?.hasProject;
}
function renderBreadcrumbs() {
  const container=$("breadcrumbs");container.replaceChildren();if(!browser.directory)return;
  const path=browser.directory,separator=path.includes("\\")?"\\":"/",parts=path.split(separator).filter(Boolean);
  if(separator==="/"&&!path.startsWith("\\"))container.append(button("/",run(()=>navigateFiles("/"))));
  parts.forEach((part,index)=>{
    let destination=parts.slice(0,index+1).join(separator);
    if(separator==="/")destination="/"+destination;
    else if(path.startsWith("\\\\"))destination="\\\\"+destination;
    if(separator==="\\"&&index===0&&!path.startsWith("\\\\"))destination+="\\";
    if(index)container.append(node("span","","›"));container.append(button(part,run(()=>navigateFiles(destination))));
  });
}
function selectFile(event,item) {
  const items=fileItems();
  if(event.shiftKey&&browser.anchor){
    const from=items.findIndex(entry=>entry.path===browser.anchor),to=items.indexOf(item);
    if(!event.ctrlKey)browser.selected.clear();
    items.slice(Math.max(0,Math.min(from,to)),Math.max(from,to)+1).forEach(entry=>browser.selected.add(entry.path));
  } else if(event.ctrlKey||event.metaKey){browser.selected.has(item.path)?browser.selected.delete(item.path):browser.selected.add(item.path);browser.anchor=item.path;}
  else {browser.selected=new Set([item.path]);browser.anchor=item.path;}
  renderFileSelection();
}
async function openFile(item) {
  if(item.link){await window.fileBrowserApi.showSystem(browser.directory);return;}
  if(item.type==="folder"){await navigateFiles(item.path);return;}
  if(item.type==="image"&&browser.purpose==="image"){browser.selected=new Set([item.path]);await pickFile();return;}
  if(item.name==="project.json"){await openProject(browser.directory);$("filesDialog").close();return;}
  await window.fileBrowserApi.open(item.path);
}
async function pickFile() {
  if(browser.purpose==="project"){
    if(!browser.listing?.hasProject)return;await openProject(browser.directory);
  } else if(browser.purpose==="image"){
    const selected=selectedFiles();if(selected.length!==1||selected[0].type!=="image")return;
    await importImage(selected[0],browser.side);
  }
  $("filesDialog").close();
}
function clipboard(mode) {
  const items=selectedFiles();if(!items.length)return;
  browser.clipboard={mode,paths:items.map(item=>item.path)};renderFiles();
  toast((mode==="copy"?"Скопировано: ":"Вырезано: ")+items.length+". Откройте папку назначения и нажмите «Вставить».");
}
async function pasteFiles(destination=browser.directory) {
  if(!browser.clipboard)return;
  await saveProject();
  const moving=browser.clipboard.mode==="move";
  await window.fileBrowserApi.list(destination,$("showHidden").checked);
  const result=await window.fileBrowserApi.transfer(browser.clipboard.paths,destination,browser.clipboard.mode);
  if(moving)for(const entry of result.transfers)await relocateProject(entry.source,entry.target);
  if(browser.clipboard.mode==="move"){browser.clipboard.paths=browser.clipboard.paths.filter(path=>result.errors.some(error=>error.path===path));if(!browser.clipboard.paths.length)browser.clipboard=null;}
  await navigateFiles(browser.directory,false);browser.selected=new Set(result.paths);renderFileSelection();
  if(result.errors.length)toast(result.errors.map(error=>error.message).join("\n"),true);
  else toast("Готово: "+result.paths.length);
}
async function dropFiles(event,destination) {
  event.preventDefault();event.stopPropagation();
  const raw=event.dataTransfer.getData("application/x-soldermap-files");if(!raw)return;
  const paths=JSON.parse(raw);browser.clipboard={mode:event.ctrlKey?"copy":"move",paths};await pasteFiles(destination);
}
async function createFolder() {
  const name=await ask("Новая папка","","Новая папка","Создать");if(!name)return;
  const target=await window.fileBrowserApi.newFolder(browser.directory,name);await navigateFiles(browser.directory,false);
  browser.selected=new Set([target]);renderFileSelection();
}
async function renameFile() {
  const [item]=selectedFiles();if(browser.selected.size!==1||!item)return;
  const name=await ask("Переименовать","",item.name,"Переименовать");if(!name||name===item.name)return;
  await saveProject();
  const target=await window.fileBrowserApi.rename(item.path,name);
  await relocateProject(item.path,target);await navigateFiles(browser.directory,false);
  browser.selected=new Set([target]);renderFileSelection();
}
async function relocateProject(from,to) {
  if(!state.folder||from===to)return;
  const old=from.replace(/[\\/]+$/,""),current=state.folder.toLowerCase(),prefix=old.toLowerCase();
  if(current!==prefix&&!current.startsWith(prefix+"\\")&&!current.startsWith(prefix+"/"))return;
  const folder=to+state.folder.slice(old.length);
  await window.fileBrowserApi.list(folder,false);
  await window.projectApi.readProject(folder);
  state.folder=folder;await loadBoard();render();
}
async function trashFiles() {
  const selected=selectedFiles();if(!selected.length)return;
  if(!await ask("Переместить в корзину?","Выбрано: "+selected.length+"\n"+selected.slice(0,7).map(item=>item.name).join("\n"),null,"В корзину"))return;
  await saveProject();
  const result=await window.fileBrowserApi.trash(selected.map(item=>item.path));
  if(result.paths.some(path=>state.folder===path||state.folder?.startsWith(path+"\\")||state.folder?.startsWith(path+"/"))){state.project=null;state.folder=null;resetWorkspace();await loadBoard();render();}
  await navigateFiles(browser.directory,false);
  if(result.errors.length)toast(result.errors.map(error=>error.message).join("\n"),true);
}
function fileContext(event,item) {
  event.preventDefault();event.stopPropagation();
  if(item&&!browser.selected.has(item.path)){browser.selected=new Set([item.path]);browser.anchor=item.path;renderFileSelection();}
  const count=selectedFiles().length;
  showContext(event,[
    ...(item?[{label:"Открыть",action:()=>openFile(item)},null]:[]),
    {label:"Вырезать",action:()=>clipboard("move"),disabled:!count},
    {label:"Копировать",action:()=>clipboard("copy"),disabled:!count},
    {label:"Вставить",action:()=>pasteFiles(),disabled:!browser.clipboard},
    {label:"Переименовать",action:renameFile,disabled:count!==1},
    {label:"В корзину",action:trashFiles,disabled:!count},null,
    {label:"Новая папка",action:createFolder},
    {label:"Открыть системный проводник",action:()=>window.fileBrowserApi.showSystem(browser.directory)}
  ]);
}

function connect() {
  const click=(id,callback)=>$(id).addEventListener("click",run(callback));
  click("windowMin",()=>window.windowControls.minimize());click("windowMax",()=>window.windowControls.maximize());click("windowClose",closeApp);
  window.windowControls.onCloseRequest(run(closeApp));
  click("projectsButton",showProjects);click("emptyProjects",showProjects);
  click("filesButton",()=>openBrowser());click("newProject",newProject);click("openProjectFolder",()=>openBrowser("project"));
  click("saveButton",saveProject);click("undoButton",()=>historyAction());click("redoButton",()=>historyAction(true));
  click("topButton",()=>setSide("TOP"));click("bottomButton",()=>setSide("BOTTOM"));
  click("loadImage",()=>state.project&&openBrowser("image",state.side));
  click("solderMode",()=>{state.mode="solder";state.drawing=false;state.placeTarget=null;render();});click("editMode",()=>{state.mode="edit";render();});
  click("addComponent",()=>{state.drawing=!state.drawing;state.placeTarget=null;render();});
  click("placeComponent",()=>{const c=selectedComponent();if(c){state.drawing=true;state.placeTarget=A.key(c);render();toast("Нарисуйте область для "+c.ref);}});
  click("zoomIn",()=>setZoom(state.scale*1.25));click("zoomOut",()=>setZoom(state.scale/1.25));click("zoomLabel",()=>setZoom(1));click("fitBoard",fitBoard);
  $("zoomSlider").addEventListener("input",event=>setZoom(Number(event.target.value)/100));
  $("boardViewport").addEventListener("wheel",event=>{
    if(!$("boardSizer").hidden){event.preventDefault();const rect=$("boardViewport").getBoundingClientRect();setZoom(state.scale*Math.exp(-event.deltaY*.0015),{x:event.clientX-rect.left,y:event.clientY-rect.top});}
  },{passive:false});
  $("boardViewport").addEventListener("pointerdown",beginBoard);$("boardViewport").addEventListener("pointermove",moveBoard);
  $("boardViewport").addEventListener("pointerup",endBoard);$("boardViewport").addEventListener("pointercancel",endBoard);
  $("searchInput").addEventListener("input",event=>{state.filters.query=event.target.value;renderList();renderBoard();});
  for(const [id,field] of [["statusFilter","status"],["stageFilter","stage"],["groupFilter","group"]])$(id).addEventListener("change",event=>{state.filters[field]=event.target.value;render();});
  $("batchSort").addEventListener("change",event=>{state.sort=event.target.value;renderList();});
  click("batchesTab",()=>{state.tab="batches";state.filters.nominal="";render();});click("componentsTab",()=>{state.tab="components";render();});
  click("resetFilters",clearFilters);click("clearNominal",()=>{state.filters.nominal="";state.tab="batches";render();});
  $("nominalChip").lastElementChild.addEventListener("click",()=>{state.filters.nominal="";state.tab="batches";render();});
  click("clearSelection",()=>{state.selected=null;render();});
  click("toggleSolder",()=>toggleSolder());click("sameNominal",()=>sameNominal());click("applyComponent",applyComponent);click("deleteComponent",deleteSelected);
  click("markBatch",async()=>{
    const batch=currentBatch();if(!batch||!batch.remaining)return;
    if(!await ask("Отметить партию припаянной?",state.side+" · "+batch.label+"\nОставшихся компонентов: "+batch.remaining,null,"Отметить припаянными"))return;
    mutate(()=>batch.components.forEach(c=>{state.project.doneMap[A.key(c)]=true;}));
  });
  document.querySelectorAll("[data-close]").forEach(el=>el.addEventListener("click",()=>$(el.dataset.close).close()));
  $("promptForm").addEventListener("submit",event=>{event.preventDefault();answerPrompt(true);});click("promptCancel",()=>answerPrompt(false));
  $("promptDialog").addEventListener("cancel",event=>{event.preventDefault();answerPrompt(false);});
  click("fileBack",()=>travelFiles(-1));click("fileForward",()=>travelFiles(1));click("fileUp",()=>browser.listing?.parentPath&&navigateFiles(browser.listing.parentPath));
  click("fileRefresh",()=>navigateFiles(browser.directory,false));
  $("addressForm").addEventListener("submit",run(async event=>{event.preventDefault();await navigateFiles($("fileAddress").value.trim());}));
  $("fileSearch").addEventListener("input",()=>{browser.selected.clear();browser.anchor=null;renderFiles();});
  $("showHidden").addEventListener("change",run(()=>navigateFiles(browser.directory,false)));
  click("fileNewFolder",createFolder);click("fileCut",()=>clipboard("move"));click("fileCopy",()=>clipboard("copy"));click("filePaste",()=>pasteFiles());
  click("fileRename",renameFile);click("fileDelete",trashFiles);click("fileSystem",()=>window.fileBrowserApi.showSystem(browser.directory));click("filePick",pickFile);
  click("fileView",()=>{browser.mode=browser.mode==="tiles"?"details":"tiles";renderFiles();});
  document.querySelectorAll("[data-file-sort]").forEach(el=>el.addEventListener("click",()=>{if(browser.sort===el.dataset.fileSort)browser.ascending=!browser.ascending;else{browser.sort=el.dataset.fileSort;browser.ascending=true;}renderFiles();}));
  $("fileItems").addEventListener("click",event=>{if(event.target===$("fileItems")){browser.selected.clear();renderFileSelection();}});
  $("fileItems").addEventListener("contextmenu",event=>{if(!event.target.closest(".file-row"))fileContext(event);});
  $("fileItems").addEventListener("dragover",event=>event.preventDefault());
  $("fileItems").addEventListener("drop",run(event=>dropFiles(event,browser.directory)));
  $("filesDialog").addEventListener("close",hideContext);
  document.addEventListener("pointerdown",event=>{if(!event.target.closest("#contextMenu"))hideContext();});
  document.addEventListener("keydown",run(keyboard));
  document.addEventListener("keyup",event=>{if(event.code==="Space")state.space=false;});
  window.addEventListener("blur",()=>{state.space=false;});
}
async function keyboard(event) {
  const editable=event.target.matches("input,textarea,select"),ctrl=event.ctrlKey||event.metaKey;
  if($("promptDialog").open)return;
  if(event.key==="Escape"){hideContext();if(state.drawing){state.drawing=false;render();}return;}
  if($("filesDialog").open) {
    if((ctrl&&event.key.toLowerCase()==="l")||(event.altKey&&event.key.toLowerCase()==="d")){event.preventDefault();$("fileAddress").focus();$("fileAddress").select();return;}
    if(editable){if(event.key==="F5"){event.preventDefault();await navigateFiles(browser.directory,false);}return;}
    if(ctrl&&event.key.toLowerCase()==="a"){event.preventDefault();browser.selected=new Set(fileItems().map(item=>item.path));renderFileSelection();}
    else if(ctrl&&event.key.toLowerCase()==="c"){event.preventDefault();clipboard("copy");}
    else if(ctrl&&event.key.toLowerCase()==="x"){event.preventDefault();clipboard("move");}
    else if(ctrl&&event.key.toLowerCase()==="v"){event.preventDefault();await pasteFiles();}
    else if(event.key==="F2"){event.preventDefault();await renameFile();}
    else if(event.key==="Delete"){event.preventDefault();await trashFiles();}
    else if(event.key==="F5"){event.preventDefault();await navigateFiles(browser.directory,false);}
    else if(event.altKey&&event.key==="ArrowLeft"){event.preventDefault();await travelFiles(-1);}
    else if(event.altKey&&event.key==="ArrowRight"){event.preventDefault();await travelFiles(1);}
    else if(event.altKey&&event.key==="ArrowUp"){event.preventDefault();if(browser.listing?.parentPath)await navigateFiles(browser.listing.parentPath);}
    else if(event.key==="Enter"&&selectedFiles().length===1){event.preventDefault();await openFile(selectedFiles()[0]);}
    else if(event.key==="ArrowDown"||event.key==="ArrowUp"){
      event.preventDefault();const items=fileItems(),index=items.findIndex(item=>browser.selected.has(item.path)),next=items[Math.max(0,Math.min(items.length-1,index+(event.key==="ArrowDown"?1:-1)))];
      if(next)selectFile(event,next);
    }
    return;
  }
  if($("projectsDialog").open)return;
  if(ctrl&&event.key.toLowerCase()==="s"){event.preventDefault();await saveProject();return;}
  if(editable)return;
  if(ctrl&&event.key.toLowerCase()==="z"){event.preventDefault();await historyAction(event.shiftKey);}
  else if(ctrl&&event.key.toLowerCase()==="y"){event.preventDefault();await historyAction(true);}
  else if(ctrl&&event.key.toLowerCase()==="f"){event.preventDefault();$("searchInput").focus();}
  else if(event.code==="Space"){event.preventDefault();state.space=true;}
  else if(event.key==="+"||event.key==="="){event.preventDefault();setZoom(state.scale*1.25);}
  else if(event.key==="-"){event.preventDefault();setZoom(state.scale/1.25);}
  else if(event.key==="0"){event.preventDefault();fitBoard();}
  else if(event.key==="Enter"&&selectedComponent()){event.preventDefault();toggleSolder();}
  else if(event.key==="Delete"&&state.mode==="edit"){event.preventDefault();await deleteSelected();}
}
connect();render();run(showProjects)();
