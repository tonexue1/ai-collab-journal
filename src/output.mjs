// Diagnostics describe structure, never quote model output or source messages.
export class OutputValidationError extends Error {
  constructor(issues) {
    super(`模型输出校验失败：${issues.slice(0, 3).map(x => `${x.path} ${x.message}`).join('；')}${issues.length > 3 ? `；另有 ${issues.length - 3} 项` : ''}`);
    this.name = 'OutputValidationError';
    this.code = 'MODEL_OUTPUT_INVALID';
    this.issues = issues;
  }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalize = text => text.replace(/\s+/g, ' ').trim();

export function validateOutput(text, items) {
  let value,source;
  try {
    source = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    value = JSON.parse(source);
  } catch {
    // Observed provider output ended after its final complete item, omitting
    // only the outer ]}. Add no content: incomplete strings/inner containers
    // still cannot parse, and every required item/field must already exist.
    if(source?.endsWith('}'))try {
      const candidate=JSON.parse(source+']}');
      if(object(candidate)&&Object.keys(candidate).length===1&&Object.hasOwn(candidate,'items')
        &&Array.isArray(candidate.items)&&candidate.items.length===items.length
        &&candidate.items.every(x=>object(x)&&Object.hasOwn(x,'id')&&Object.hasOwn(x,'summary')&&Object.hasOwn(x,'details')&&Array.isArray(x.details)))value=candidate;
    }catch{}
    // JSON.parse errors may contain private excerpts from the response.
    if(value===undefined)throw new OutputValidationError([{path: '$', code: 'INVALID_JSON', message: '必须返回完整 JSON 对象'}]);
  }
  if (!object(value) || !Array.isArray(value.items)) {
    throw new OutputValidationError([{path: 'items', code: 'INVALID_ITEMS', message: '必须是数组'}]);
  }
  const issues = [], expected = new Set(items.map(x => x.id)), seen = new Set(), results = new Map();
  const issue = (path, code, message) => issues.push({path, code, message});
  if (value.items.length !== items.length) issue('items', 'ITEM_COUNT', `需要 ${items.length} 项，实际 ${value.items.length} 项`);
  // A malformed oversized array should not produce unbounded diagnostics.
  for (const [i, x] of value.items.slice(0, items.length + 1).entries()) {
    const path = `items[${i}]`;
    if (!object(x)) {issue(path, 'INVALID_ITEM', '必须是对象'); continue;}
    if (!expected.has(x.id)) issue(`${path}.id`, 'UNKNOWN_ID', '必须逐字复制输入项的 id');
    else if (seen.has(x.id)) issue(`${path}.id`, 'DUPLICATE_ID', '重复，每个输入 id 只能出现一次');
    else seen.add(x.id);
    const summary = typeof x.summary === 'string' ? normalize(x.summary) : '';
    if (typeof x.summary !== 'string' || !summary) issue(`${path}.summary`, 'INVALID_SUMMARY', '必须是非空字符串');
    else if (summary.length > 180) issue(`${path}.summary`, 'SUMMARY_LENGTH', `最多 180 字符，实际 ${summary.length} 字符`);
    // These conversions preserve all text. Never truncate evidence or guess IDs.
    const details = x.details == null ? [] : typeof x.details === 'string' ? [x.details] : x.details;
    if (!Array.isArray(details)) issue(`${path}.details`, 'INVALID_DETAILS', '必须是字符串数组');
    else {
      if (details.length > 3) issue(`${path}.details`, 'DETAIL_COUNT', `最多 3 条，实际 ${details.length} 条`);
      details.slice(0, 4).forEach((d, j) => {
        if (typeof d !== 'string') issue(`${path}.details[${j}]`, 'INVALID_DETAIL', '必须是字符串');
        else if (normalize(d).length > 240) issue(`${path}.details[${j}]`, 'DETAIL_LENGTH', `最多 240 字符，实际 ${normalize(d).length} 字符`);
      });
    }
    if (!issues.length) results.set(x.id, {id: x.id, summary, details: details.map(normalize).filter(Boolean)});
  }
  if (seen.size !== expected.size) issue('items', 'MISSING_ID', `缺少 ${expected.size - seen.size} 个输入 id`);
  if (issues.length) throw new OutputValidationError(issues);
  return items.map(x => results.get(x.id));
}
