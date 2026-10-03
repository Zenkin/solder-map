const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
const {childPath,isWithin,transfer}=require("../js/file-operations.js");
async function workspace(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"soldermap-files-"));
  assert.ok(isWithin(os.tmpdir(),root));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return root;
}
test("file names cannot escape their directory or use reserved Windows names",()=>{
  for(const name of ["..","../outside","a/b","a\\b","C:bad","NUL","CON.txt","file."])assert.throws(()=>childPath("root",name),name);
  assert.equal(childPath("root","Моя плата 2.png"),path.join("root","Моя плата 2.png"));
  assert.ok(isWithin(path.resolve("root"),path.resolve("root","nested","file")));
  assert.ok(!isWithin(path.resolve("root"),path.resolve("root-other","file")));
});
test("copy preserves the source and creates a new name instead of overwriting",async t=>{
  const root=await workspace(t),source=path.join(root,"long PCB name.txt");
  await fs.writeFile(source,"first");
  const destination=await transfer(source,root,"copy");
  assert.equal(path.basename(destination),"long PCB name (2).txt");
  assert.equal(await fs.readFile(source,"utf8"),"first");
  assert.equal(await fs.readFile(destination,"utf8"),"first");
});
test("moving folders preserves nested contents and removes only the original",async t=>{
  const root=await workspace(t),source=path.join(root,"source"),destination=path.join(root,"destination");
  await fs.mkdir(path.join(source,"nested"),{recursive:true});await fs.mkdir(destination);
  await fs.writeFile(path.join(source,"nested","pcb.txt"),"board");
  const moved=await transfer(source,destination,"move");
  assert.equal(await fs.readFile(path.join(moved,"nested","pcb.txt"),"utf8"),"board");
  await assert.rejects(fs.access(source),{code:"ENOENT"});
  assert.equal(await transfer(moved,destination,"move"),moved);
});
test("self and descendant folder transfers are rejected without changing files",async t=>{
  const root=await workspace(t),nested=path.join(root,"nested");await fs.mkdir(nested);
  await fs.writeFile(path.join(root,"keep.txt"),"unchanged");
  await assert.rejects(transfer(root,nested,"copy"),/внутрь самой себя/);
  await assert.rejects(transfer(root,root,"move"),/внутрь самой себя/);
  await assert.rejects(transfer(path.join(root,"keep.txt"),nested,"delete"),/Неизвестная/);
  assert.equal(await fs.readFile(path.join(root,"keep.txt"),"utf8"),"unchanged");
});
