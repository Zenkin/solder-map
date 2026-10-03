const {contextBridge, ipcRenderer} = require("electron");
contextBridge.exposeInMainWorld("projectApi", {
  listProjects:() => ipcRenderer.invoke("projects:list"),
  createProjectFolder:name => ipcRenderer.invoke("projects:create",name),
  readProject:folder => ipcRenderer.invoke("project:read",folder),
  writeProject:(folder,project) => ipcRenderer.invoke("project:write",folder,project),
  imageUrl:(folder,name) => ipcRenderer.invoke("project:image-url",folder,name),
  copyImage:(folder,source,side) => ipcRenderer.invoke("project:copy-image",folder,source,side)
});
contextBridge.exposeInMainWorld("fileBrowserApi", {
  places:() => ipcRenderer.invoke("files:places"),
  list:(folder,hidden) => ipcRenderer.invoke("files:list",folder,hidden),
  chooseDirectory:() => ipcRenderer.invoke("files:choose-directory"),
  newFolder:(folder,name) => ipcRenderer.invoke("files:new-folder",folder,name),
  rename:(file,name) => ipcRenderer.invoke("files:rename",file,name),
  transfer:(files,folder,mode) => ipcRenderer.invoke("files:transfer",files,folder,mode),
  trash:files => ipcRenderer.invoke("files:trash",files),
  open:file => ipcRenderer.invoke("files:open",file),
  showSystem:folder => ipcRenderer.invoke("files:show-system",folder)
});
contextBridge.exposeInMainWorld("windowControls", {
  minimize:() => ipcRenderer.send("window:minimize"),
  maximize:() => ipcRenderer.send("window:maximize"),
  close:() => ipcRenderer.send("window:close-ready"),
  onCloseRequest:callback => {
    const listener=() => callback();
    ipcRenderer.on("window:request-close",listener);
    return () => ipcRenderer.removeListener("window:request-close",listener);
  }
});
