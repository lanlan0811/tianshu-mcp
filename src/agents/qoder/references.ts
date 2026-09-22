import fs from 'node:fs/promises';
import path from 'node:path';

export async function validateQoderReferences(project: string, plan?: string): Promise<string> {
  if(!plan?.trim())throw new Error('Qoder CN 必须提供 planDoc');
  if(!(await fs.stat(project)).isDirectory())throw new Error('Qoder projectPath 必须是现有目录');
  const file=path.resolve(project,plan);
  if(!(await fs.stat(file)).isFile())throw new Error('Qoder planDoc 必须是可读取的文件');
  await fs.access(file,fs.constants.R_OK);
  return file;
}
