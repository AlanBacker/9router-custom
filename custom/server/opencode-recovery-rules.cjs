'use strict';
function classifyFailure(status,body){
  const detail=body?.error||body||{};
  const code=String(detail.code||detail.type||'').toLowerCase();
  const message=String(detail.message||'');
  if(/\bendpoint is unavailable\b/i.test(message))return {kind:'endpoint'};
  if([400,401,403,404,410,422,429].includes(status)&&(
    /^(invalid_session(?:_id)?|session_expired|session_not_found)$/.test(code)||
    /\b(?:session(?: id)?|x-opencode-session)(?: is| has)? (?:invalid|expired|not found)\b|\b(?:invalid|expired) (?:opencode )?session(?: id)?\b/i.test(message)
  ))return {kind:'session',reason:'invalid_session'};
  if(status===401||/\b(?:account|api[ _-]?key|credential|token)\b.{0,60}\b(?:banned|disabled|invalid|revoked|suspended)\b|\binvalid (?:api[ _-]?key|credential|token)\b/i.test(message))return {kind:'auth'};
  return {kind:status===429?'rate':status===403?'access':[407,408,502,503,504].includes(status)?'gateway':'other'};
}
function transportFailure(error){
  const code=String(error?.cause?.code||error?.code||'');
  return /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|SOCKET|CONNECT_ERROR)|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID)$/.test(code)||(error?.name==='TypeError'&&error.message==='fetch failed');
}
module.exports={classifyFailure,transportFailure};
