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
  await fs.writeFile(path.join(folder,"project.json"),JSON.stringify({version:3,name:"Демо",images:{TOP:{file:"top.png"},BOTTOM:{file:"bottom.png"}},imageSizes:{TOP:{w:512,h:512},BOTTOM:{w:512,h:512}},components,doneMap:{"TOP:R1":true},extraPayload:{a:1}}));
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
    assert.equal(await execute('filtered().length'),3);
    await command('const c=state.project.components.find(c=>c.side==="BOTTOM");componentContext({preventDefault(){},stopPropagation(){},clientX:450,clientY:280},c);');
    await execute('$("contextMenu").firstElementChild.click()');await waitFor('state.filters.nominal && filtered().length===3',"context nominal");
    await execute('$("topButton").click()');await waitFor('state.side==="TOP" && !state.filters.nominal',"return top");
    await execute('$("searchInput").value="100nf";$("searchInput").dispatchEvent(new Event("input",{bubbles:true}));');
    assert.equal(await execute('filtered().length'),6);
    await execute('$("searchInput").value="R2, R8";$("searchInput").dispatchEvent(new Event("input",{bubbles:true}));');
    assert.equal(await execute('filtered().length'),2);
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
    await command('await openBrowser("image","BOTTOM",'+JSON.stringify(fixture.files)+');const item=fileItems().find(f=>f.name==="board.png");selectFile({},item);');
    await execute('$("filePick").click()');await waitFor('!$("filesDialog").open && state.project.images.BOTTOM.file==="bottom (2).png"',"import side image");
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
    assert.equal(await execute('document.body.scrollWidth <= innerWidth'),true);
    await command('await openBrowser("browse",null,'+JSON.stringify(fixture.files)+');');
    assert.equal(await execute('$("fileItems").scrollWidth <= $("fileItems").clientWidth'),true);
    const filesScreenshot=await win.webContents.capturePage();
    await fs.writeFile(path.join(root,"soldermap-files.png"),filesScreenshot.toPNG());
    assert.deepEqual(errors,[]);
    console.log("PASS Electron smoke: projects, legacy data, side batches, context menu, solder/undo, search, wheel zoom, draw/edit, files copy/conflict/new/rename, image import, active project relocation, narrow layout. Screenshots: "+root);
    win.destroy();app.quit();
  }catch(error){console.error(error);console.error(errors);win?.destroy();app.exit(1);}
});
