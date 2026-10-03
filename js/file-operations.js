const fs = require("node:fs/promises");
const path = require("node:path");

function childPath(directory, name) {
  const value=String(name || "").trim();
  if (!value || value === "." || value === ".." || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) throw new Error("Недопустимое имя файла или папки.");
  return path.join(directory,value);
}
function isWithin(root, target) {
  const relative=path.relative(path.resolve(root),path.resolve(target));
  return relative!=="" && relative!==".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function availablePath(directory, name) {
  let candidate=childPath(directory,name),index=2;
  const parsed=path.parse(name);
  while (true) {
    try { await fs.lstat(candidate); }
    catch(e) { if(e.code==="ENOENT")return candidate; throw e; }
    candidate=childPath(directory,`${parsed.name} (${index++})${parsed.ext}`);
  }
}
async function transfer(source, directory, mode) {
  if (!['copy','move'].includes(mode)) throw new Error("Неизвестная операция.");
  const sourcePath=await fs.realpath(source), directoryPath=await fs.realpath(directory);
  const stat=await fs.lstat(source);
  if(stat.isSymbolicLink()) throw new Error("Операции со ссылками доступны в системном проводнике.");
  if (!(await fs.stat(directoryPath)).isDirectory()) throw new Error("Выберите папку назначения.");
  if (sourcePath===directoryPath || (stat.isDirectory()&&isWithin(sourcePath,directoryPath))) throw new Error("Нельзя поместить папку внутрь самой себя.");
  if(mode==='move'&&path.dirname(sourcePath)===directoryPath) return sourcePath;
  const target=await availablePath(directoryPath,path.basename(sourcePath));
  if(mode==='move') {
    try { await fs.rename(sourcePath,target); return target; }
    catch(e) { if(e.code!=="EXDEV")throw e; }
  }
  await fs.cp(sourcePath,target,{recursive:true,errorOnExist:true,force:false,dereference:false});
  if(mode==='move') await fs.rm(sourcePath,{recursive:true});
  return target;
}
module.exports={childPath,isWithin,availablePath,transfer};
