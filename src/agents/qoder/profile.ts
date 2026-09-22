import { AgentProfileSchema } from '../../config/schema.js';

/** Installation roots and timing are profile data, overridable in agent-profiles.json. */
export const QODER_PROFILE = AgentProfileSchema.parse({
  displayName:'Qoder CN', driver:'gui', adapter:'qoder-gui',
  status: process.platform==='win32'?'ready':'research', command:null,
  authNote:'复用 Qoder CN 登录态；无法连接的已有实例须用户处理，不自动重启。',
  executableDiscovery:{
    preferredDrives:['D:'],
    relativePaths:['Qoder CN/Qoder CN.exe','Program Files/Qoder CN/Qoder CN.exe'],
    fileNames:process.platform==='darwin'?['Qoder CN']:['Qoder CN.exe'],
    dirs:process.platform==='darwin'?['/Applications/Qoder CN.app/Contents/MacOS','{HOME}/Applications/Qoder CN.app/Contents/MacOS']:
      ['{LOCALAPPDATA}/Programs/Qoder CN','{PROGRAMFILES}/Qoder CN','{PROGRAMFILES(X86)}/Qoder CN'],
  },
  gui:{cdpPort:9777,cdpPortRange:20,launchTimeoutMs:90000,cdpSendTimeoutMs:30000,stableRounds:2,defaultAutoFixRounds:3,modeSwitch:false,modelRequired:false},
  note:'Qoder CN GUI；Windows 已验证默认/自定义模型开发与返修闭环，macOS research 禁止派发。',
});
