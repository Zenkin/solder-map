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
  assert.ok(A.matchesSearch(component("U1","LM358"),"LM358"));
  assert.ok(A.matchesSearch(component("U1","STM32F103"),"STM32"));
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
test("1 kOhm search excludes unrelated values despite matching reference, power or tolerance digits",()=>{
  const components=[
    component("R1","0.1Вт 0603 1 кОм, 0.1%"),
    component("R2","0.25Вт 0805 1000 Ом, 1%"),
    component("R5","0.1Вт 0603 1.5 кОм, 1%"),
    component("R11","49,9 кОм","TOP",{note:"Раньше был 1 кОм"}),
    component("R12","0.1Вт 0603 10 кОм, 0.1%"),
    component("R14","191 кОм"),
    component("R15","90,9 кОм"),
    component("R1","1k","BOTTOM")
  ];
  const p=A.normalizeProject({components});
  for(const query of ["1 кОм","1k","1k0","1000 Ohms","0.001 МОм","1 kΩ"]){
    assert.deepEqual(A.visible(p,{side:"TOP",query}).map(c=>c.ref),["R1","R2"],query);
  }
  assert.deepEqual(A.visible(p,{side:"TOP",query:"1 кОм 0603"}).map(c=>c.ref),["R1"]);
  assert.deepEqual(A.visible(p,{side:"TOP",query:"R2 1кОм"}).map(c=>c.ref),["R2"]);
  assert.deepEqual(A.visible(p,{side:"TOP",query:"1,5 кОм"}).map(c=>c.ref),["R5"]);
  assert.equal(p.components[0].value,components[0].value);
});
test("compound descriptions form the same batches as plain nominals while retaining details",()=>{
  for(const [ref,descriptions,plain] of [
    ["R1",["0.1Вт 0603 1 кОм, 0.1%","0603 1 000 Ом ±1%","1k 0805 0.25W","4k7 0603 1%"],["1k","1k","1k","4.7k"]],
    ["C1",["0603 100 нФ 50В X7R","0.1µF 16V 0603","4n7 50V"],["0.1uF","100nF","4700pF"]]
  ])descriptions.forEach((description,i)=>{
    const c=component(ref,description),n=A.nominal(c);
    assert.equal(n.key,A.nominal(component(ref,plain[i])).key,description);
    assert.equal(n.description,description);
    assert.ok(A.matchesSearch(c,plain[i]),description);
  });
  const resistor=component("R1","0.1Вт 0603 1 кОм, 0.1%");
  assert.equal(A.nominal(resistor).label,"1 кОм");
  assert.ok(!A.matchesSearch(resistor,"0.1 Ом"));
  assert.ok(!A.matchesSearch(component("R1","Резистор 0603 1%"),"1 Ом"));
  assert.ok(!A.matchesSearch(component("R1","1 кОм / 10 кОм"),"1 кОм"));
});
test("capacitor unit queries use exact values and do not fall back to metadata or digit substrings",()=>{
  for(const value of ["1 нФ 50В 0603","1000 пФ 16В","0.001uF X7R"])assert.ok(A.matchesSearch(component("C1",value),"1nF"),value);
  for(const value of ["10 нФ 50В 0603","100 нФ 16В 1%","1uF 0603"])assert.ok(!A.matchesSearch(component("C1",value),"1 нФ"),value);
  assert.ok(!A.matchesSearch(component("R1","1000 Ом"),"1 нФ"));
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
