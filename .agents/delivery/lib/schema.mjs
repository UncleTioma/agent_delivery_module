// Minimal JSON Schema subset validator: type, enum, required, properties, items.

function typeOk(v, t) {
  switch (t) {
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number';
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return true;
  }
}

export function validate(data, schema, path = '$', errors = []) {
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(data, t))) {
      errors.push(`${path}: wrong type`);
      return errors;
    }
  }
  if ('enum' in schema && !schema.enum.includes(data)) {
    errors.push(`${path}: value not allowed`);
  }
  if (typeOk(data, 'object')) {
    for (const key of schema.required ?? []) {
      if (!(key in data)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in data) validate(data[key], sub, `${path}.${key}`, errors);
    }
  }
  if (Array.isArray(data) && schema.items) {
    data.forEach((item, i) => validate(item, schema.items, `${path}[${i}]`, errors));
  }
  return errors;
}
