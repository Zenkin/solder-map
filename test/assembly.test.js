const test=require("node:test");
const assert=require("node:assert/strict");
const A=require("../js/assembly.js");
const component=(ref,value,side="TOP",extra={})=>({ref,value,side,x:10,y:20,w:30,h:40,...extra});

test("equivalent resistor and capacitor notations share a nominal, different types do not",()=>{
  for(const values of [["10k","10 кОм","10000 Ohm"],["4k7","4.7k","4700"],["2R2","2.2 Ом"],["0.1 uF","100 нФ","100000pF"]]){
    const ref=values.includes("100 нФ")?"C1":"R1";
    assert.equal(new Set(values.map(value=>A.nominal(component(ref,value)).key)).size,1);
  }
  assert.notEqual(A.nominal(component("R1","100")).key,A.nominal(component("C1","100")).key);
  assert.equal(A.nominal(component("R1","")).label,"Без номинала");
});
test("search accepts references, lists, unit variants, type, package and notes",()=>{
  const r=component("R12","10 кОм","TOP",{type:"0603",note:"Делитель питания"});
  for(const query of ["r12","R8, R12","10k","10000ohm","резистор 0603","делитель"])assert.ok(A.matchesSearch(r,query),query);
  assert.ok(A.matchesSearch(component("C1","0.1µF"),"100 нФ"));
  assert.ok(!A.matchesSearch(r,"R8; R9"));
  assert.ok(!A.matchesSearch(r,"R1"));
  assert.ok(!A.matchesSearch(r,"22k"));
});
test("side filters and largest remaining batches isolate the assembly sequence",()=>{
  const components=[
    ...Array.from({length:8},(_,i)=>component("R"+(i+1),"10k")),
    ...Array.from({length:6},(_,i)=>component("C"+(i+1),"100n")),
    component("R20","1k"),
    ...Array.from({length:15},(_,i)=>component("R"+(i+1),"10k","BOTTOM"))
  ];
  const p=A.normalizeProject({components,doneMap:{"TOP:R1":true,"TOP:R2":true,"TOP:R3":true}});
  const top=A.visible(p,{side:"TOP"}),batches=A.batches(top,p.doneMap);
  assert.deepEqual(batches.map(b=>[b.type,b.remaining,b.total]),[["C",6,6],["R",5,8],["R",1,1]]);
  assert.equal(A.batches(top,p.doneMap,"total")[0].total,8);
  const nominal=A.nominal(components[0]).key;
  assert.equal(A.visible(p,{side:"TOP",nominal,status:"pending"}).length,5);
  assert.equal(A.visible(p,{side:"BOTTOM",nominal}).length,15);
  assert.equal(A.visible(p,{side:"TOP",status:"done"}).length,3);
});
test("opening old projects preserves pixel geometry, images, stages and solder marks while whitelisting fields",()=>{
  const c=component("R1","10k","TOP",{stage:"1",group:"питание",oldPayload:{a:1},unplaced:true});
  const source={version:2,name:"Плата",images:{TOP:{file:"top.png",originalName:"PCB.png"},BOTTOM:"bottom.png"},imageSizes:{TOP:{w:2000,h:1200}},stages:[{id:"1",name:"Пассивные",order:1,color:"#f00"}],components:[c],doneMap:{"TOP:R1":true,"TOP:missing":true},oldPayload:{a:1}};
  const p=A.normalizeProject(source);
  assert.equal(p.images.TOP.file,"top.png");assert.equal(p.images.BOTTOM.file,"bottom.png");
  assert.deepEqual([p.components[0].x,p.components[0].y,p.components[0].w,p.components[0].h],[10,20,30,40]);
  assert.equal(p.components[0].unplaced,true);
  assert.deepEqual(p.doneMap,{"TOP:R1":true});
  assert.deepEqual(p.stages,[{id:"1",name:"Пассивные",order:1}]);
  assert.ok(!("oldPayload" in p));assert.ok(!("oldPayload" in p.components[0]));
  assert.deepEqual(A.normalizeProject(JSON.parse(JSON.stringify(p))),p);
});
test("unique references do not overwrite existing geometry or progress",()=>{
  const p=A.normalizeProject({components:[component("T1","10k"),component("T1","22k"),component("T3","47k"),component("T1","10k","BOTTOM")],doneMap:{"TOP:T1":true}});
  assert.equal(new Set(p.components.map(A.key)).size,4);
  assert.equal(p.doneMap["TOP:T1_2"],undefined);
  assert.equal(A.nextRef(p.components,"TOP"),"T2");
});
test("zoom keeps the point under the cursor fixed and clamps usable scale",()=>{
  const old={scale:.5},anchor={x:187,y:139},scroll={left:440,top:290};
  const next=A.zoomAt(old,2,anchor,scroll);
  assert.equal((scroll.left+anchor.x)/old.scale,(next.left+anchor.x)/next.scale);
  assert.equal((scroll.top+anchor.y)/old.scale,(next.top+anchor.y)/next.scale);
  assert.equal(A.zoomAt(old,99,anchor,scroll).scale,8);
  assert.equal(A.zoomAt(old,0,anchor,scroll).scale,.05);
});
