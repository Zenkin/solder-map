// Electron-only integration runner, separate from the Node test discovery directory.
const {app,BrowserWindow}=require("electron");
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
const root=path.join(process.env.SOLDERMAP_SMOKE_ROOT || os.tmpdir(),"soldermap-smoke-"+Date.now());
process.env.SOLDERMAP_PROJECTS_ROOT=path.join(root,"projects");
const source=process.env.SOLDERMAP_SMOKE_APP || path.resolve(__dirname,"..");
let win;
const errors=[];
app.on("browser-window-created",(_event,window)=>{
  win=window;
  window.webContents.on("console-message",(_event,level,message)=>{if(level>=3)errors.push(message);});
  window.webContents.on("did-fail-load",(_event,code,message)=>errors.push(code+" "+message));
});
require(path.join(source,"main.js"));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const execute=code=>win.webContents.executeJavaScript(code);
async function waitFor(code,label) {
  for(let i=0;i<200;i++){if(await execute(code))return;await delay(25);}
  throw new Error("Timed out: "+label+"; "+await execute('$("toast").textContent'));
}
function command(code) { return execute("(async()=>{"+code+"})()"); }
async function assertBoardCentered(label) {
  const geometry='(()=>{const v=$("boardViewport"),vr=v.getBoundingClientRect(),r=$("boardCanvas").getBoundingClientRect();return {dx:r.left+r.width/2-(vr.left+v.clientLeft+v.clientWidth/2),dy:r.top+r.height/2-(vr.top+v.clientTop+v.clientHeight/2),overflowX:v.scrollWidth-v.clientWidth,overflowY:v.scrollHeight-v.clientHeight};})()';
  await waitFor('(()=>{const p='+geometry+';return Math.abs(p.dx)<1 && Math.abs(p.dy)<1 && p.overflowX===0 && p.overflowY===0;})()',label+" centered");
  const position=await execute(geometry);
  assert.ok(Math.abs(position.dx)<1 && Math.abs(position.dy)<1,label+": "+JSON.stringify(position));
  assert.equal(position.overflowX,0,label+" horizontal overflow");
  assert.equal(position.overflowY,0,label+" vertical overflow");
}
async function hoverComponent(ref) {
  const point=await execute('(()=>{const r=$("overlays").querySelector(\'[data-key="TOP:'+ref+'"]\').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()');
  win.webContents.sendInputEvent({type:"mouseMove",...point});
  await waitFor('!$("componentTooltip").hidden && $("componentTooltip").dataset.key==="TOP:'+ref+'"',"hover "+ref);
}
async function assertTooltipReadable(label) {
  const geometry=await execute('(()=>{const t=$("componentTooltip"),r=t.getBoundingClientRect(),v=$("boardViewport"),b=v.getBoundingClientRect(),ref=t.querySelector(".tooltip-ref");return {inside:r.left>=b.left+v.clientLeft && r.right<=b.left+v.clientLeft+v.clientWidth && r.top>=b.top+v.clientTop && r.bottom<=b.top+v.clientTop+v.clientHeight,font:parseFloat(getComputedStyle(ref).fontSize),textHeight:ref.getBoundingClientRect().height,overflow:t.scrollWidth-t.clientWidth,clipped:t.scrollHeight-t.clientHeight,scaledAncestor:!!t.closest("#boardCanvas")};})()');
  assert.ok(geometry.inside,label+" fits viewport");assert.equal(geometry.font,22,label+" font size");assert.ok(geometry.textHeight>=26,label+" rendered text size");
  assert.equal(geometry.overflow,0,label+" wraps text");assert.equal(geometry.clipped,0,label+" complete text");assert.equal(geometry.scaledAncestor,false,label+" outside zoom transform");
}
async function setup() {
  const folder=path.join(root,"projects","Демо"),files=path.join(root,"files");
  await fs.mkdir(folder,{recursive:true});await fs.mkdir(path.join(files,"Назначение"),{recursive:true});
  const icon=path.join(source,"assets","app-icon.png");
  await fs.copyFile(icon,path.join(folder,"top.png"));await fs.copyFile(icon,path.join(folder,"bottom.png"));
  await fs.copyFile(icon,path.join(files,"board.png"));
  await fs.writeFile(path.join(files,"Очень длинное название файла платы чтобы текст не выходил за границы строки проводника и полностью оставался доступным пользователю.txt"),"smoke");
  const components=[];
  for(let i=0;i<8;i++)components.push({ref:"R"+(i+1),value:i%2?"10 кОм":"10k",side:"TOP",x:35+i%4*110,y:95+Math.floor(i/4)*95,w:75,h:35});
  for(let i=0;i<6;i++)components.push({ref:"C"+(i+1),value:i%2?"0.1uF":"100 нФ",side:"TOP",x:35+i%3*155,y:300+Math.floor(i/3)*80,w:70,h:40});
  for(let i=0;i<3;i++)components.push({ref:"R"+(i+1),value:"10k",side:"BOTTOM",x:70+i*120,y:180,w:75,h:35});
  await fs.writeFile(path.join(folder,"project.json"),JSON.stringify({version:3,name:"Демо",images:{TOP:{file:"top.png"},BOTTOM:{file:"bottom.png"}},imageSizes:{TOP:{w:512,h:512},BOTTOM:{w:512,h:512}},components,doneMap:{"TOP:R1":true,"BOTTOM:R1":true},extraPayload:{a:1}}));
  return {folder,files};
}
app.whenReady().then(async()=>{
  try{
    const fixture=await setup();
    if(win.webContents.isLoading())await new Promise(resolve=>win.webContents.once("did-finish-load",resolve));
    await waitFor('typeof state !== "undefined" && $("projectsDialog").open',"startup");
    await command("await showProjects();");
    await execute('$("projectsList").querySelector("button").click()');
    await waitFor('state.project?.components.length===17 && !$("boardSizer").hidden',"open legacy project");
    await assertBoardCentered("open project");
    for(const [w,h] of [[300,900],[1400,400],[200,100]]) {
      await command('state.project.imageSizes.TOP={w:'+w+',h:'+h+'};await loadBoard();');
      await assertBoardCentered("load "+w+"x"+h);
    }
    await command('state.project.imageSizes.TOP={w:512,h:512};await loadBoard();');
    win.setSize(1100,740);await delay(100);
    await assertBoardCentered("resize fitted view");
    // Zoom must preserve the image point under the cursor after the centered offset changes.
    const zoomPoint=await execute('(()=>{const v=$("boardViewport"),vr=v.getBoundingClientRect(),r=$("boardCanvas").getBoundingClientRect();const x=r.left-vr.left-v.clientLeft+r.width*.44,y=r.top-vr.top-v.clientTop+r.height*.52;return {x,y,imageX:(x+v.scrollLeft-state.boardOffset.left)/state.scale,imageY:(y+v.scrollTop-state.boardOffset.top)/state.scale};})()');
    await command('setZoom(4,'+JSON.stringify({x:zoomPoint.x,y:zoomPoint.y})+');');
    const zoomedPoint=await execute('({x:('+zoomPoint.x+'+$("boardViewport").scrollLeft-state.boardOffset.left)/state.scale,y:('+zoomPoint.y+'+$("boardViewport").scrollTop-state.boardOffset.top)/state.scale})');
    assert.ok(Math.abs(zoomedPoint.x-zoomPoint.imageX)<.5 && Math.abs(zoomedPoint.y-zoomPoint.imageY)<.5,"zoom cursor anchor");
    win.setSize(1200,800);await delay(100);
    assert.equal(await execute('state.scale'),4,"resize preserves manual zoom");
    const panBefore=await execute('({left:$("boardViewport").scrollLeft,top:$("boardViewport").scrollTop})');
    win.webContents.sendInputEvent({type:"mouseDown",button:"middle",x:600,y:400,clickCount:1});
    win.webContents.sendInputEvent({type:"mouseMove",x:630,y:440});
    win.webContents.sendInputEvent({type:"mouseUp",button:"middle",x:630,y:440,clickCount:1});await delay(50);
    const panAfter=await execute('({left:$("boardViewport").scrollLeft,top:$("boardViewport").scrollTop})');
    assert.equal(panAfter.left,panBefore.left-30);assert.equal(panAfter.top,panBefore.top-40);
    await command('selectComponent(state.project.components.find(c=>c.side==="TOP" && c.ref==="R6"),true);');
    assert.ok(await execute('(()=>{const v=$("boardViewport"),vr=v.getBoundingClientRect(),r=$("overlays").querySelector(\'[data-key="TOP:R6"]\').getBoundingClientRect();return Math.abs(r.left+r.width/2-vr.left-v.clientLeft-v.clientWidth/2)<1 && Math.abs(r.top+r.height/2-vr.top-v.clientTop-v.clientHeight/2)<1;})()'),"focus component in zoomed view");
    win.setSize(1460,960);await delay(100);
    await execute('$("fitBoard").click()');
    await assertBoardCentered("fit after zoom and pan");
    // Hover information stays readable at both zoom limits and wraps at every viewport edge.
    await command('const c=state.project.components.find(c=>c.side==="TOP" && c.ref==="R1");c.value="0.1Вт 0603 10 кОм, 0.1%";renderBoard();');
    for(const scale of [.05,.4,4,8]) {
      await command('setZoom('+scale+');focusComponent(state.project.components.find(c=>c.side==="TOP" && c.ref==="R1"));');await delay(50);
      await hoverComponent("R1");await assertTooltipReadable("hover at "+scale*100+"%");
      assert.equal(await execute('$("componentTooltip").querySelector(".tooltip-nominal").textContent'),"10 кОм");
      assert.ok((await execute('$("componentTooltip").textContent')).includes("0.1Вт 0603"));
      assert.ok((await execute('$("componentTooltip").textContent')).includes("Припаян"));
      if(scale===.4)await fs.writeFile(path.join(root,"soldermap-tooltip.png"),(await win.webContents.capturePage()).toPNG());
    }
    await command('state.project.components.find(c=>c.side==="TOP" && c.ref==="R1").value="ОченьДлинноеОписаниеКомпонентаБезПробелов".repeat(6).slice(0,200);renderBoard();');
    for(const [x,y] of [[1,1],[0,1],[1,0],[0,0]]) {
      await command('const v=$("boardViewport"),r=v.getBoundingClientRect(),box=$("overlays").querySelector(\'[data-key="TOP:R1"]\');box.dispatchEvent(new PointerEvent("pointermove",{clientX:r.left+v.clientLeft+'+x+'*(v.clientWidth-2)+1,clientY:r.top+v.clientTop+'+y+'*(v.clientHeight-2)+1,bubbles:true}));');
      await assertTooltipReadable("hover corner "+x+","+y);
    }
    await execute('setZoom(1)');assert.equal(await execute('$("componentTooltip").hidden'),true,"hide on zoom");
    await command('state.project.components.find(c=>c.side==="TOP" && c.ref==="R1").value="10k";renderBoard();fitBoard();');
    await delay(50);await hoverComponent("R1");
    win.webContents.sendInputEvent({type:"mouseMove",x:30,y:110});
    await waitFor('$("componentTooltip").hidden',"hide when pointer leaves board");
    assert.equal(await execute('state.project.doneMap["TOP:R1"]'),true);
    assert.equal(await execute('Object.hasOwn(state.project,"extraPayload")'),false);
    assert.deepEqual(await execute('A.batches(filtered(),state.project.doneMap).map(b=>[b.type,b.remaining,b.total])'),[["R",7,8],["C",6,6]]);
    await execute('$("componentList").querySelector(".batch-row").click()');
    assert.equal(await execute('filtered().length'),8);
    assert.equal(await execute('state.side'),"TOP");
    assert.equal(await execute('$("overlays").querySelectorAll(".batch-match").length'),8);
    assert.equal(await execute('$("overlays").querySelectorAll(".done").length'),1);
    await execute('$("toggleSolder").click()');await waitFor('state.project.doneMap["TOP:R2"]===true',"solder mark");
    await execute('$("undoButton").click()');await waitFor('!state.project.doneMap["TOP:R2"]',"undo solder mark");
    await execute('$("bottomButton").click()');await waitFor('state.side==="BOTTOM" && $("boardImage").src.includes("bottom.png")',"bottom side");
    await assertBoardCentered("switch bottom");
    assert.equal(await execute('filtered().length'),3);
    await command('const c=state.project.components.find(c=>c.side==="BOTTOM");componentContext({preventDefault(){},stopPropagation(){},clientX:450,clientY:280},c);');
    await execute('$("contextMenu").firstElementChild.click()');await waitFor('state.filters.nominal && filtered().length===3',"context nominal");
    await execute('$("topButton").click()');await waitFor('state.side==="TOP" && !state.filters.nominal',"return top");
    await waitFor('!$("boardSizer").hidden',"top image loaded");await assertBoardCentered("switch top");
    await execute('$("searchInput").value="100nf";$("searchInput").dispatchEvent(new Event("input",{bubbles:true}));');
    assert.equal(await execute('filtered().length'),6);
    await execute('$("searchInput").value="R2, R8";$("searchInput").dispatchEvent(new Event("input",{bubbles:true}));');
    assert.equal(await execute('filtered().length'),2);
    // Simulate imported descriptions containing package, power and tolerance numbers.
    const originalValues=await execute('state.project.components.filter(c=>c.side==="TOP" && c.ref.startsWith("R")).map(c=>[c.ref,c.value])');
    await command('for(const c of state.project.components.filter(c=>c.side==="TOP" && c.ref.startsWith("R"))){const values={R1:"0.1Вт 0603 1 кОм, 0.1%",R2:"0.1Вт 0603 1000 Ом, 0.1%",R3:"0.1Вт 0603 1.5 кОм, 1%",R4:"49,9 кОм",R5:"0.1Вт 0603 10 кОм, 0.1%",R6:"191 кОм",R7:"90,9 кОм",R8:"1k"};c.value=values[c.ref];}state.tab="components";render();');
    await execute('$("searchInput").value="1 кОм";$("searchInput").dispatchEvent(new Event("input",{bubbles:true}));');
    assert.deepEqual(await execute('filtered().map(c=>c.ref)'),["R1","R2","R8"]);
    assert.equal(await execute('$("componentList").querySelectorAll(".component-row").length'),3);
    assert.ok((await execute('$("componentList").firstElementChild.textContent')).includes("0.1Вт 0603"));
    await command('selectComponent(state.project.components.find(c=>c.side==="TOP"&&c.ref==="R1"));sameNominal();');
    assert.deepEqual(await execute('filtered().map(c=>c.ref)'),["R1","R2","R8"]);
    assert.ok((await execute('$("selectedNote").textContent')).includes("0.1Вт 0603"));
    await command('const values='+JSON.stringify(originalValues)+';for(const [ref,value] of values)state.project.components.find(c=>c.side==="TOP"&&c.ref===ref).value=value;clearFilters();');
    await execute('$("resetFilters").click()');
    // Reset applies to both sides even when the visible list hides soldered items.
    await execute('$("searchInput").value="100nf";$("searchInput").dispatchEvent(new Event("input",{bubbles:true}));$("statusFilter").value="pending";$("statusFilter").dispatchEvent(new Event("change",{bubbles:true}));');
    await execute('$("resetSoldering").click()');await waitFor('$("promptDialog").open',"reset solder prompt");
    await execute('$("promptCancel").click()');
    assert.deepEqual(await execute('state.project.doneMap'),{"TOP:R1":true,"BOTTOM:R1":true});
    await execute('$("resetSoldering").click()');await waitFor('$("promptDialog").open',"reset solder confirmation");
    await execute('$("promptForm").requestSubmit()');await waitFor('Object.keys(state.project.doneMap).length===0',"reset both sides");
    assert.equal(await execute('state.filters.status'),"all");
    assert.equal(await execute('$("resetSoldering").disabled'),true);
    assert.equal(await execute('$("overlays").querySelectorAll(".done").length'),0);
    await command('await saveProject();');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(fixture.folder,"project.json"),"utf8")).doneMap,{});
    await execute('$("undoButton").click()');await waitFor('state.project.doneMap["TOP:R1"] && state.project.doneMap["BOTTOM:R1"]',"undo reset");
    assert.equal(await execute('$("resetSoldering").disabled'),false);
    await execute('$("redoButton").click()');await waitFor('Object.keys(state.project.doneMap).length===0',"redo reset");
    await execute('$("undoButton").click()');await waitFor('state.project.doneMap["TOP:R1"] && state.project.doneMap["BOTTOM:R1"]',"restore fixture marks");
    await execute('$("resetFilters").click()');
    const previous=await execute('state.scale');
    await execute('$("boardViewport").dispatchEvent(new WheelEvent("wheel",{deltaY:-400,clientX:600,clientY:400,bubbles:true,cancelable:true}));');
    assert.ok(await execute('state.scale')>previous);
    await execute('$("zoomLabel").click()');assert.equal(await execute('state.scale'),1);
    await execute('$("editMode").click();$("addComponent").click()');
    await command('const rect=$("boardCanvas").getBoundingClientRect();const target=$("boardViewport");for(const [type,x,y] of [["pointerdown",15,15],["pointermove",85,65],["pointerup",85,65]])target.dispatchEvent(new PointerEvent(type,{clientX:rect.left+x,clientY:rect.top+y,button:0,pointerId:1,bubbles:true}));');
    await waitFor('state.project.components.length===18',"draw rectangle");
    await execute('$("editRef").value="R50";$("editValue").value="4k7";$("applyComponent").click()');
    await waitFor('selectedComponent()?.ref==="R50" && selectedComponent()?.value==="4k7"',"edit properties");
    assert.equal(await execute('selectedComponent().w'),70);
    await execute('$("solderMode").click()');
    await command('await openBrowser("browse",null,'+JSON.stringify(fixture.files)+');');
    assert.equal(await execute('fileItems().length'),3);
    assert.equal(await execute('$("fileItems").scrollWidth <= $("fileItems").clientWidth'),true);
    await command('const file=fileItems().find(f=>f.name.endsWith(".txt"));selectFile({ctrlKey:false,shiftKey:false},file);clipboard("copy");await navigateFiles('+JSON.stringify(path.join(fixture.files,"Назначение"))+');await pasteFiles();');
    assert.equal((await fs.readdir(path.join(fixture.files,"Назначение"))).length,1);
    await command('await pasteFiles();');
    assert.equal((await fs.readdir(path.join(fixture.files,"Назначение"))).length,2);
    await execute('$("fileNewFolder").click()');await waitFor('$("promptDialog").open',"new folder prompt");
    await execute('$("promptInput").value="Тест";$("promptForm").requestSubmit()');
    await waitFor('fileItems().some(item=>item.name==="Тест")',"new folder");
    await command('const item=fileItems().find(f=>f.name==="Тест");selectFile({},item);');
    await execute('$("fileRename").click()');await waitFor('$("promptDialog").open',"rename prompt");
    await execute('$("promptInput").value="Переименовано";$("promptForm").requestSubmit()');
    await waitFor('fileItems().some(item=>item.name==="Переименовано")',"rename folder");
    await command('await setSide("BOTTOM");await openBrowser("image","BOTTOM",'+JSON.stringify(fixture.files)+');const item=fileItems().find(f=>f.name==="board.png");selectFile({},item);');
    await execute('$("filePick").click()');await waitFor('!$("filesDialog").open && state.project.images.BOTTOM.file==="bottom (2).png"',"import side image");
    await waitFor('!$("boardSizer").hidden',"image import loaded");await assertBoardCentered("import image");
    await command('await setSide("TOP");');
    await command('await saveProject();');
    const saved=JSON.parse(await fs.readFile(path.join(fixture.folder,"project.json"),"utf8"));
    assert.equal(saved.components.length,18);assert.equal(saved.doneMap["TOP:R1"],true);assert.ok(!("extraPayload" in saved));
    await command('await openBrowser("browse",null,'+JSON.stringify(path.dirname(fixture.folder))+');const item=fileItems().find(f=>f.name==="Демо");selectFile({},item);');
    await execute('$("fileRename").click()');await waitFor('$("promptDialog").open',"active project rename");
    await execute('$("promptInput").value="Демо новое";$("promptForm").requestSubmit()');
    await waitFor('state.folder.endsWith("Демо новое") && !$("boardSizer").hidden',"active project relocation");
    await command('await saveProject();$("filesDialog").close();state.selected=null;clearFilters();state.mode="solder";render();fitBoard();');
    await delay(250);
    const screenshot=await win.webContents.capturePage();
    await fs.writeFile(path.join(root,"soldermap-workspace.png"),screenshot.toPNG());
    win.setSize(980,680);await delay(100);
    await assertBoardCentered("narrow fitted view");
    assert.equal(await execute('document.body.scrollWidth <= innerWidth'),true);
    await command('await openBrowser("browse",null,'+JSON.stringify(fixture.files)+');');
    assert.equal(await execute('$("fileItems").scrollWidth <= $("fileItems").clientWidth'),true);
    const filesScreenshot=await win.webContents.capturePage();
    await fs.writeFile(path.join(root,"soldermap-files.png"),filesScreenshot.toPNG());
    assert.deepEqual(errors,[]);
    console.log("PASS Electron smoke: projects, legacy data, board centering/load/side/import/fit/resize, readable hover at 5–800%/viewport edges, zoom anchoring/pan, side batches, context menu, solder/undo, project solder reset/cancel/undo/redo/persist, search, wheel zoom, draw/edit, files copy/conflict/new/rename, image import, active project relocation, narrow layout. Screenshots: "+root);
    win.destroy();app.quit();
  }catch(error){console.error(error);console.error(errors);win?.destroy();app.exit(1);}
});
