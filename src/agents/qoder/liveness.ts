export interface QoderPoll {
  sessionId?:string;
  userId?:string;
  userText:string;
  assistantId?:string;
  assistantText:string;
  running:boolean;
  completed:boolean;
  waiting?: 'agent_question'|'user_confirmation'|'login_required'|'setup_recovery';
  waitingText?:string;
}
/** Completion must belong to the sent user turn. Static text and previous turns never qualify. */
export function judgeQoderPoll(p:QoderPoll,expectedUserId?:string):'running'|'completed'|'needs_user'|'unknown' {
  if(p.waiting)return 'needs_user';
  if(p.running)return 'running';
  if(expectedUserId&&p.userId===expectedUserId&&p.assistantId===`assistant:${expectedUserId}`&&p.completed)return 'completed';
  return 'unknown';
}
