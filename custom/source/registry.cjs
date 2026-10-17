#!/usr/bin/env node
'use strict';
const MARK = '9R_OC_POOL_V1';

function transformRegistry(code) {
  let count = 0;
  const pattern = /(\bid\s*:\s*["']opencode["'][\s\S]{0,1200}?\bcategory\s*:\s*)["']free["'](\s*,\s*noAuth\s*:\s*)(?:true|!0)/g;
  code = code.replace(pattern, (whole, before, between) => {
    if (!/\bname\s*:\s*["']OpenCode Free["']/.test(before) || !/\balias\s*:\s*["']oc["']/.test(before)) {
      throw new Error('OpenCode registry identity could not be verified.');
    }
    count++;
    // The transport's own noAuth stays true. Only credential selection/UI uses this flag.
    return `${before}"freeTier"${between}false/*${MARK}*/,authModes:["apikey"]`;
  });
  return {code, count};
}


module.exports={transformRegistry};
