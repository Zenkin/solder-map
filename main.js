const {app, BrowserWindow, Menu, dialog, ipcMain, shell} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {childPath, availablePath, isWithin, transfer} = require("./js/file-operations.js");
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"]);
const projects = new Set(), listedItems = new Set(), listedDirectories = new Set(), writeQueues = new Map();
let window;
const storePath = () => process.env.SOLDERMAP_PROJECTS_ROOT || path.join(app.getPath("documents"), "SolderMap Projects");
if (process.env.SOLDERMAP_PROJECTS_ROOT) app.setPath("userData", path.join(storePath(), ".app-data"));
const norm = p => process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
const grantProject = p => { projects.add(norm(p)); return p; };

async function projectPath(value) {
  const target = await fs.realpath(String(value));
  if (!projects.has(norm(target))) throw new Error("Сначала откройте проект.");
  return target;
}
async function knownItem(value) {
  const target = path.resolve(String(value));
  if (!listedItems.has(norm(target))) throw new Error("Сначала откройте папку в проводнике.");
  if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("Откройте ссылку в системном проводнике.");
  return target;
}
async function knownDirectory(value) {
  const target = await fs.realpath(String(value));
  if (!listedDirectories.has(norm(target))) throw new Error("Сначала откройте папку назначения.");
  return target;
}
function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== window?.webContents) throw new Error("Недоступный отправитель.");
    return callback(...args);
  });
}
function createWindow() {
  window = new BrowserWindow({
    width:1460, height:960, minWidth:980, minHeight:680, frame:false, backgroundColor:"#f3f5f8",
    icon:path.join(__dirname, "assets/app-icon.png"),
    webPreferences:{preload:path.join(__dirname, "preload.js"), contextIsolation:true, nodeIntegration:false}
  });
  window.webContents.setWindowOpenHandler(() => ({action:"deny"}));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.loadFile(path.join(__dirname,"index.html"));
  let closing = false;
  window.on("close", event => {
    if (!closing) { event.preventDefault(); window.webContents.send("window:request-close"); }
  });
  ipcMain.removeAllListeners("window:close-ready");
  ipcMain.on("window:close-ready", async event => {
    if (event.sender !== window?.webContents) return;
    await Promise.allSettled([...writeQueues.values()]);
    closing = true;
    window.close();
  });
}
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
ipcMain.on("window:minimize", event => { if (event.sender === window?.webContents) window.minimize(); });
ipcMain.on("window:maximize", event => {
  if (event.sender === window?.webContents) window.isMaximized() ? window.unmaximize() : window.maximize();
});

handle("projects:list", async () => {
  const root = storePath();
  await fs.mkdir(root, {recursive:true});
  const result = [];
  for (const entry of await fs.readdir(root, {withFileTypes:true})) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const folder = path.join(root, entry.name);
    try {
      const data = JSON.parse((await fs.readFile(path.join(folder, "project.json"), "utf8")).replace(/^\uFEFF/,""));
      const stat = await fs.stat(path.join(folder, "project.json"));
      result.push({path:grantProject(await fs.realpath(folder)), name:String(data.name || entry.name), updatedAt:stat.mtimeMs});
    } catch { /* Incomplete folders are available in the file browser. */ }
  }
  return result.sort((a,b) => b.updatedAt-a.updatedAt);
});
handle("projects:create", async name => {
  await fs.mkdir(storePath(), {recursive:true});
  const safe = String(name || "Новый проект").trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").slice(0,80).replace(/[. ]+$/, "") || "Новый проект";
  const target = await availablePath(storePath(), safe);
  await fs.mkdir(target);
  return {path:grantProject(await fs.realpath(target)), name:safe};
});
handle("project:read", async value => {
  const folder = await fs.realpath(String(value));
  if (!projects.has(norm(folder)) && !listedDirectories.has(norm(folder))) throw new Error("Откройте папку проекта в проводнике.");
  const data = JSON.parse((await fs.readFile(path.join(folder,"project.json"),"utf8")).replace(/^\uFEFF/,""));
  grantProject(folder);
  return data;
});
handle("project:write", async (value, project) => {
  const folder = await projectPath(value), json = JSON.stringify(project,null,2);
  if (json.length > 50*1024*1024) throw new Error("Проект слишком большой.");
  const previous = writeQueues.get(folder) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const temporary = path.join(folder, `.project-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
    try {
      await fs.writeFile(temporary, json, {encoding:"utf8", flag:"wx"});
      await fs.rename(temporary, path.join(folder,"project.json"));
    } finally { await fs.unlink(temporary).catch(() => {}); }
  });
  writeQueues.set(folder,next);
  try { await next; }
  finally { if (writeQueues.get(folder) === next) writeQueues.delete(folder); }
});
handle("project:image-url", async (value, name) => {
  const folder = await projectPath(value);
  const target = await fs.realpath(childPath(folder,name));
  if (!isWithin(folder,target) || !imageExtensions.has(path.extname(target).toLowerCase())) throw new Error("Недоступное изображение.");
  const stat = await fs.stat(target);
  return `${pathToFileURL(target).href}?v=${stat.mtimeMs}`;
});
handle("project:copy-image", async (value, source, side) => {
  const folder = await projectPath(value), from = await knownItem(source);
  const ext = path.extname(from).toLowerCase();
  if (!["TOP","BOTTOM"].includes(side) || !imageExtensions.has(ext)) throw new Error("Выберите изображение платы.");
  // A new unique name also avoids following pre-existing links and stale image caches.
  const target = await availablePath(folder, `${side.toLowerCase()}${ext}`);
  await fs.copyFile(from,target, require("node:fs").constants.COPYFILE_EXCL);
  return {file:path.basename(target), originalName:path.basename(from), url:pathToFileURL(target).href};
});
handle("files:places", async () => {
  await fs.mkdir(storePath(),{recursive:true});
  const places = [{name:"Проекты SolderMap",path:storePath()}];
  for (const [name,key] of [["Изображения","pictures"],["Рабочий стол","desktop"],["Загрузки","downloads"],["Документы","documents"],["Домашняя папка","home"]]) {
    try { places.push({name,path:app.getPath(key)}); } catch {}
  }
  if (process.platform === "win32") {
    for (let n=65;n<=90;n++) {
      const drive = String.fromCharCode(n)+":\\";
      try { await fs.access(drive); places.push({name:"Диск "+drive,path:drive}); } catch {}
    }
  } else places.push({name:"Файловая система",path:"/"});
  const existing = [];
  for (const place of places) { try { await fs.access(place.path); existing.push(place); } catch {} }
  return existing;
});
handle("files:choose-directory", async () => {
  const result = await dialog.showOpenDialog(window,{title:"Выберите папку",properties:["openDirectory","createDirectory"]});
  return result.canceled ? null : result.filePaths[0];
});
handle("files:list", async (value, hidden=false) => {
  const directory = await fs.realpath(String(value));
  if (!(await fs.stat(directory)).isDirectory()) throw new Error("Это не папка.");
  listedDirectories.add(norm(directory));
  const items = [];
  for (const entry of await fs.readdir(directory,{withFileTypes:true})) {
    if (!hidden && entry.name.startsWith(".")) continue;
    const target = path.join(directory,entry.name);
    try {
      const stat = await fs.lstat(target), ext=path.extname(target).toLowerCase();
      const type = stat.isDirectory() ? "folder" : imageExtensions.has(ext) ? "image" : "file";
      listedItems.add(norm(target));
      items.push({name:entry.name,path:target,type,size:stat.size,modifiedAt:stat.mtimeMs,link:stat.isSymbolicLink(),url:type==="image"?pathToFileURL(target).href:null});
    } catch { /* An entry can disappear while reading. */ }
  }
  const parent = path.dirname(directory);
  return {path:directory,parentPath:parent===directory?null:parent,hasProject:items.some(item=>item.name==="project.json"),items};
});
handle("files:new-folder", async (value,name) => {
  const folder=await knownDirectory(value),target=childPath(folder,name);
  await fs.mkdir(target); return target;
});
handle("files:rename", async (value,name) => {
  const from=await knownItem(value),target=childPath(path.dirname(from),name);
  if (from===target) return target;
  if (norm(from)!==norm(target)) {
    try { await fs.lstat(target); throw new Error("Такое имя уже занято."); }
    catch(e) { if(e.code!=="ENOENT")throw e; }
  }
  await fs.rename(from,target);
  listedItems.delete(norm(from));
  return target;
});
handle("files:transfer", async (values,destination,mode) => {
  if (!Array.isArray(values) || !values.length || values.length>1000) throw new Error("Выберите файлы.");
  const directory=await knownDirectory(destination),result={paths:[],transfers:[],errors:[]};
  for (const value of values) {
    try {
      const target=await transfer(await knownItem(value),directory,mode);
      result.paths.push(target);result.transfers.push({source:value,target});
    }
    catch(e) { result.errors.push({path:value,message:e.message}); }
  }
  return result;
});
handle("files:trash", async values => {
  if (!Array.isArray(values) || !values.length || values.length>1000) throw new Error("Выберите файлы.");
  const result={paths:[],errors:[]};
  for (const value of values) {
    try {
      const target=await knownItem(value);
      if (projects.has(norm(await fs.realpath(target)))) await (writeQueues.get(target) || Promise.resolve());
      await shell.trashItem(target); listedItems.delete(norm(target)); result.paths.push(target);
    } catch(e) { result.errors.push({path:value,message:e.message}); }
  }
  return result;
});
handle("files:open", async value => {
  const error=await shell.openPath(await knownItem(value));
  if(error)throw new Error(error);
});
handle("files:show-system", async value => {
  const error=await shell.openPath(await knownDirectory(value));
  if(error)throw new Error(error);
});
