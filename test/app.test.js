const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const A=require("../js/assembly.js");

class Element {
  constructor() {
    this.children=[];this.listeners={};this.style={};this.dataset={};this.hidden=false;
    this.value="";this.open=false;this.clientWidth=1000;this.clientHeight=700;
    this.classList={toggle(){}};
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children=children; }
  addEventListener(type,handler) { (this.listeners[type]??=[]).push(handler); }
  setAttribute() {}
  showModal() { this.open=true; }
  close() { this.open=false; }
  focus() {}
  select() {}
  get firstElementChild() { return this.children[0]; }
  get lastElementChild() { return this.children.at(-1); }
  async dispatch(type,event={target:this}) { for(const handler of this.listeners[type]||[])await handler(event); }
  click() { return this.dispatch("click"); }
}

function renderer(platform="linux") {
  const elements=new Map(),calls=[];
  const element=id=>{
    if(!elements.has(id))elements.set(id,new Element());
    return elements.get(id);
  };
  element("nominalChip").append(new Element(),new Element());
  const context=vm.createContext({
    document:{getElementById:element,createElement:()=>new Element(),querySelectorAll:()=>[],addEventListener(){}},
    window:{
      SolderMapAssembly:A,addEventListener(){},windowControls:{onCloseRequest(){}},
      fileBrowserApi:{platform,list:async(folder,hidden)=>{calls.push({method:"list",folder,hidden});}},
      projectApi:{
        readProject:async folder=>{calls.push({method:"read",folder});},
        writeProject:async(folder,project)=>{calls.push({method:"write",folder,project});}
      }
    },
    // Keep autosave and prompt-focus timers idle; tests drive confirmation and saves explicitly.
    setTimeout:()=>1,clearTimeout(){},ResizeObserver:class {observe(){}}
  });
  const source=fs.readFileSync(path.join(__dirname,"../js/app.js"),"utf8");
  const startup=/connect\(\);render\(\);run\(showProjects\)\(\);\s*$/;
  assert.match(source,startup,"renderer startup must be the only omitted code");
  vm.runInContext(source.replace(startup,"")+"\n globalThis.app={state,currentBatch,sameNominal,relocateProject,saveProject,render,connect,answerPrompt};",context);
  const app=context.app;
  app.state.project=fixture();app.state.folder="/tmp/PCB";
  return {...app,element,calls};
}

function fixture() {
  const component=(ref,extra={})=>({ref,value:"10k",side:"TOP",stage:"power",group:"analog",note:"front",...extra});
  return A.normalizeProject({components:[
    component("R1"),component("R2"),component("R3",{group:"digital"}),
    component("R4",{stage:"late"}),component("R5",{note:"spare"}),
    component("R6",{value:"1k"}),component("R7",{stage:"late"}),
    component("R1",{side:"BOTTOM"})
  ],doneMap:{"TOP:R2":true,"TOP:R7":true}});
}

const nominal=A.nominal(fixture().components[0]).key;
test("selected batch and its panel honor each active filter and the current side",()=>{
  const app=renderer();
  for(const [filters,refs,remaining] of [
    [{group:"analog"},["R1","R2","R4","R5","R7"],3],
    [{stage:"power"},["R1","R2","R3","R5"],3],
    [{query:"front"},["R1","R2","R3","R4","R7"],3],
    [{status:"pending"},["R1","R3","R4","R5"],4],
    [{status:"done"},["R2","R7"],0],
    [{group:"analog",stage:"power",query:"front",status:"pending"},["R1"],1]
  ]) {
    app.state.filters={query:"",status:"all",stage:"",group:"",nominal,...filters};
    const batch=app.currentBatch();
    assert.deepEqual(batch.components.map(c=>c.ref),refs,JSON.stringify(filters));
    assert.ok(batch.components.every(c=>c.side==="TOP"));
    assert.equal(batch.total,refs.length);assert.equal(batch.remaining,remaining);
    app.render();
    assert.equal(app.element("batchDetail").textContent,"TOP · "+remaining+" осталось из "+refs.length+"\n"+refs.join(", "));
    assert.equal(app.element("markBatch").disabled,remaining===0);
  }
  app.state.filters.query="not present";
  assert.equal(app.currentBatch(),undefined);
  app.render();assert.equal(app.element("batchActions").hidden,true);
});

test("confirmed batch command marks only visible pending components and preserves hidden marks",async()=>{
  const app=renderer();app.connect();
  app.state.filters={query:"front",status:"pending",stage:"power",group:"analog",nominal};
  app.render();
  const marking=app.element("markBatch").click();
  assert.equal(app.element("promptDialog").open,true);
  const message=app.element("promptMessage").textContent;
  app.answerPrompt(true);await marking;
  assert.deepEqual(Object.keys(app.state.project.doneMap).sort(),["TOP:R1","TOP:R2","TOP:R7"]);
  assert.match(message,/Оставшихся компонентов: 1$/);
  assert.equal(app.state.undo.length,1);
  assert.deepEqual(Object.keys(app.state.undo[0].doneMap).sort(),["TOP:R2","TOP:R7"]);
});

test("search input refreshes the selected batch panel as the query changes",async()=>{
  const app=renderer();app.connect();
  app.state.filters.nominal=nominal;app.render();
  assert.match(app.element("batchDetail").textContent,/4 осталось из 6/);
  await app.element("searchInput").dispatch("input",{target:{value:"spare"}});
  assert.equal(app.element("batchDetail").textContent,"TOP · 1 осталось из 1\nR5");
  await app.element("searchInput").dispatch("input",{target:{value:"not present"}});
  assert.equal(app.element("batchActions").hidden,true);
});

test("context nominal command clears filters and reveals the entire batch on the selected side",()=>{
  const app=renderer();
  app.state.filters={query:"spare",status:"done",stage:"late",group:"digital",nominal:"other"};
  app.sameNominal(app.state.project.components[0]);
  assert.deepEqual({...app.state.filters},{query:"",status:"all",stage:"",group:"",nominal});
  assert.deepEqual(app.currentBatch().components.map(A.key),["TOP:R1","TOP:R2","TOP:R3","TOP:R4","TOP:R5","TOP:R7"]);
  assert.equal(app.currentBatch().remaining,4);
  assert.equal(app.state.side,"TOP");assert.equal(app.state.selected,"TOP:R1");
});

for(const platform of ["linux","darwin"])test(platform+" case-distinct sibling relocation leaves APIs and save destination untouched",async()=>{
  const app=renderer(platform);
  await app.relocateProject("/tmp/pcb","/tmp/moved");
  assert.equal(app.state.folder,"/tmp/PCB");assert.deepEqual(app.calls,[]);
  app.state.dirty=true;await app.saveProject();
  assert.deepEqual(app.calls.map(({method,folder})=>({method,folder})),[{method:"write",folder:"/tmp/PCB"}]);
});

test("POSIX active project and ancestor moves update API paths and subsequent saves",async()=>{
  for(const [current,from,to,expected] of [
    ["/tmp/PCB","/tmp/PCB","/tmp/moved","/tmp/moved"],
    ["/tmp/PCB/maps/board","/tmp/PCB/","/tmp/moved","/tmp/moved/maps/board"]
  ]) {
    const app=renderer();app.state.folder=current;
    await app.relocateProject(from,to);
    assert.equal(app.state.folder,expected);
    assert.deepEqual(app.calls,[{method:"list",folder:expected,hidden:false},{method:"read",folder:expected}]);
    app.state.dirty=true;await app.saveProject();
    assert.equal(app.calls.at(-1).method,"write");assert.equal(app.calls.at(-1).folder,expected);
  }
});

test("matching path prefixes do not relocate sibling projects",async()=>{
  for(const [platform,current,from,to] of [
    ["linux","/tmp/PCB-other/board","/tmp/PCB","/tmp/moved"],
    ["win32","C:\\Projects\\PCB-other\\Board","c:\\projects\\pcb","C:\\Moved"]
  ]) {
    const app=renderer(platform);app.state.folder=current;
    await app.relocateProject(from,to);
    assert.equal(app.state.folder,current);assert.deepEqual(app.calls,[]);
  }
});

test("Windows ancestor relocation remains case-insensitive and preserves descendant spelling",async()=>{
  const app=renderer("win32");app.state.folder="C:\\Projects\\PCB\\Board";
  await app.relocateProject("c:\\projects\\pcb","C:\\Moved\\PCB");
  const expected="C:\\Moved\\PCB\\Board";
  assert.equal(app.state.folder,expected);
  assert.deepEqual(app.calls,[{method:"list",folder:expected,hidden:false},{method:"read",folder:expected}]);
  app.state.dirty=true;await app.saveProject();assert.equal(app.calls.at(-1).folder,expected);
});

test("preload exposes the actual platform as a scalar for renderer path comparisons",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../preload.js"),"utf8");
  for(const platform of ["linux","darwin","win32"]) {
    const exposed={};
    vm.runInNewContext(source,{
      process:{platform},
      require:name=>{
        assert.equal(name,"electron");
        return {contextBridge:{exposeInMainWorld:(name,api)=>{exposed[name]=api;}},ipcRenderer:{}};
      }
    });
    assert.equal(exposed.fileBrowserApi.platform,platform);
  }
});
