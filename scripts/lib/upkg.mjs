// upkg.mjs — read an Unreal Engine 1 package (.u / .utx / .unr).
//
// Enough of the format to answer "what are this class's default properties?", which is
// where UT99 keeps every number worth having: projectile speed, splash radius, momentum,
// damage. umodel exports art but not defaults, so this is the other half of the toolchain.
//
// Written against UT99 retail (package version 68/69). Every count it reads is checked
// against the package header, and the caller can cross-check against umodel's own load
// line, which prints Names/Exports/Imports for the same file.

const MAGIC = 0x9e2a83c1;

/** UE1 "compact index": a sign bit, 6 payload bits, then 7 more per continuation byte. */
function compactIndex(buf, o) {
  let b = buf[o.p++];
  const negative = (b & 0x80) !== 0;
  let value = b & 0x3f;
  if (b & 0x40) {
    let shift = 6;
    for (let i = 0; i < 4; i++) {
      b = buf[o.p++];
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
  }
  return negative ? -value : value;
}

function readString(buf, o, version) {
  if (version < 64) {
    let end = o.p;
    while (buf[end] !== 0) end++;
    const s = buf.toString("latin1", o.p, end);
    o.p = end + 1;
    return s;
  }
  const len = buf[o.p++]; // UT99 name table: single-byte length, including the NUL
  const s = buf.toString("latin1", o.p, o.p + len - 1);
  o.p += len;
  return s;
}

export function loadPackage(buf) {
  const o = { p: 0 };
  const magic = buf.readUInt32LE(0);
  if (magic !== MAGIC) throw new Error(`not an Unreal package (magic ${magic.toString(16)})`);
  const version = buf.readUInt16LE(4);
  const licensee = buf.readUInt16LE(6);
  const flags = buf.readUInt32LE(8);
  const nameCount = buf.readInt32LE(12);
  const nameOffset = buf.readInt32LE(16);
  const exportCount = buf.readInt32LE(20);
  const exportOffset = buf.readInt32LE(24);
  const importCount = buf.readInt32LE(28);
  const importOffset = buf.readInt32LE(32);

  // --- names ---
  const names = [];
  o.p = nameOffset;
  for (let i = 0; i < nameCount; i++) {
    const name = readString(buf, o, version);
    o.p += 4; // object flags
    names.push(name);
  }

  // --- imports ---
  const imports = [];
  o.p = importOffset;
  for (let i = 0; i < importCount; i++) {
    const classPackage = names[compactIndex(buf, o)];
    const className = names[compactIndex(buf, o)];
    const pkg = buf.readInt32LE(o.p);
    o.p += 4;
    const objectName = names[compactIndex(buf, o)];
    imports.push({ classPackage, className, package: pkg, name: objectName });
  }

  // --- exports ---
  const exports_ = [];
  o.p = exportOffset;
  for (let i = 0; i < exportCount; i++) {
    const cls = compactIndex(buf, o);
    const superIdx = compactIndex(buf, o);
    const pkg = buf.readInt32LE(o.p);
    o.p += 4;
    const name = names[compactIndex(buf, o)];
    const objectFlags = buf.readUInt32LE(o.p);
    o.p += 4;
    const size = compactIndex(buf, o);
    const offset = size > 0 ? compactIndex(buf, o) : 0;
    exports_.push({ index: i, class: cls, super: superIdx, package: pkg, name, objectFlags, size, offset });
  }

  const pkgObj = {
    version,
    licensee,
    flags,
    names,
    imports,
    exports: exports_,
    buf,
    /** The name of whatever a package-wide object reference points at. */
    resolve(ref) {
      if (ref > 0) return exports_[ref - 1]?.name ?? null;
      if (ref < 0) return imports[-ref - 1]?.name ?? null;
      return null;
    },
    /** The EXPORT a positive package reference points at, or null for imports/none. */
    refExport(ref) {
      return ref > 0 ? exports_[ref - 1] ?? null : null;
    },
    /** The class name of an export, following its class reference. */
    classOf(exp) {
      return pkgObj.resolve(exp.class) ?? "Class";
    },
    find(name, className) {
      return exports_.filter(
        (e) => e.name === name && (!className || pkgObj.classOf(e) === className),
      );
    },
    /**
     * The one UClass export with this name. A name is reused across a package — a class,
     * its states and its functions all carry it — and only the class has a null class
     * reference, so asking for "UT_Eightball" without this returns a State and reads as
     * a class with no defaults at all rather than as an error.
     */
    findClass(name) {
      const hits = exports_.filter((e) => e.name === name && e.class === 0);
      if (hits.length !== 1) {
        throw new Error(`${name}: expected one class export, found ${hits.length}`);
      }
      return hits[0];
    },
  };
  return pkgObj;
}

// ---------------------------------------------------------------------------
// TAGGED PROPERTIES
// ---------------------------------------------------------------------------
// The same encoding UE1 uses for an actor placed in a level and for a class's own
// defaults: a stream of (name, type, size, value) tags ending at the name "None".
// Everything about it is packed into one info byte, and two of the packings are traps —
// a bool's VALUE lives in the array-flag bit, and a struct is followed by its type name.

const PT = {
  1: "byte", 2: "int", 3: "bool", 4: "float", 5: "object", 6: "name", 7: "string",
  8: "class", 9: "array", 10: "struct", 11: "vector", 12: "rotator", 13: "str",
  14: "map", 15: "fixedarray",
};

export function readProperties(pkg, o, end) {
  const { buf, names } = pkg;
  const out = {};
  // Object references are handed back as NAMES, which is what nearly every caller wants
  // and is also lossy: UE1 auto-names palettes "Palette<N>" per GROUP, so one package
  // holds several unrelated `Palette75`s, and looking a texture's palette up by name
  // found the first of them — which is how the Enforcer's muzzle flash came out the
  // green of the BoltHit group. The raw index is kept beside the names, non-enumerable
  // so nothing that walks the properties sees it, under `$refs` (keyed by property name,
  // `name[i]` for array elements). refExport() turns one back into an export.
  const refs = {};
  Object.defineProperty(out, "$refs", { value: refs, enumerable: false });
  while (o.p < end) {
    const nameIdx = compactIndex(buf, o);
    const name = names[nameIdx];
    if (name === "None" || name === undefined) break;
    const info = buf[o.p++];
    const type = PT[info & 0x0f];
    const sizeBits = (info >> 4) & 0x07;
    const arrayBit = (info & 0x80) !== 0;

    let structName = null;
    if (type === "struct") structName = names[compactIndex(buf, o)];

    let size;
    if (sizeBits === 0) size = 1;
    else if (sizeBits === 1) size = 2;
    else if (sizeBits === 2) size = 4;
    else if (sizeBits === 3) size = 12;
    else if (sizeBits === 4) size = 16;
    else if (sizeBits === 5) size = buf[o.p++];
    else if (sizeBits === 6) { size = buf.readUInt16LE(o.p); o.p += 2; }
    else { size = buf.readInt32LE(o.p); o.p += 4; }

    // The array-flag bit means "this is element N of an array" for every type EXCEPT
    // bool, where there is no payload at all and the bit IS the value.
    let arrayIndex = 0;
    if (arrayBit && type !== "bool") {
      const b = buf[o.p++];
      if ((b & 0x80) === 0) arrayIndex = b;
      else if ((b & 0xc0) === 0x80) { arrayIndex = ((b & 0x7f) << 8) | buf[o.p++]; }
      else {
        arrayIndex = ((b & 0x3f) << 24) | (buf[o.p] << 16) | (buf[o.p + 1] << 8) | buf[o.p + 2];
        o.p += 3;
      }
    }

    const start = o.p;
    let value;
    switch (type) {
      case "byte": value = buf[o.p]; break;
      case "int": value = buf.readInt32LE(o.p); break;
      case "bool": value = arrayBit; break;
      case "float": value = buf.readFloatLE(o.p); break;
      case "object": case "class": {
        const ref = compactIndex(buf, { p: o.p });
        value = pkg.resolve(ref);
        refs[arrayIndex ? `${name}[${arrayIndex}]` : name] = ref;
        break;
      }
      case "name": value = names[compactIndex(buf, { p: o.p })]; break;
      case "vector": value = { x: buf.readFloatLE(o.p), y: buf.readFloatLE(o.p + 4), z: buf.readFloatLE(o.p + 8) }; break;
      case "rotator": value = { pitch: buf.readInt32LE(o.p), yaw: buf.readInt32LE(o.p + 4), roll: buf.readInt32LE(o.p + 8) }; break;
      case "str": { const q = { p: o.p }; const len = compactIndex(buf, q); value = buf.toString("latin1", q.p, q.p + len - 1); break; }
      case "struct": value = { struct: structName, bytes: buf.subarray(o.p, o.p + size) }; break;
      default: value = buf.subarray(o.p, o.p + size);
    }
    if (type !== "bool") o.p = start + size;

    // A property can arrive as a scalar and then as indexed elements, or the other way
    // round. Promote to an array the moment a second element shows up rather than
    // writing through whatever the first one happened to be — assigning into a string
    // is silently ignored in sloppy mode and throws here.
    if (arrayIndex || Array.isArray(out[name])) {
      if (!Array.isArray(out[name])) out[name] = name in out ? [out[name]] : [];
      out[name][arrayIndex] = value;
    } else {
      out[name] = value;
    }
  }
  return out;
}

/**
 * The default properties of a UClass export.
 *
 * FINDING THEM IS THE WHOLE PROBLEM. They sit at the very end of the export, behind the
 * class's UnrealScript bytecode — and that bytecode CANNOT BE SKIPPED BY ITS LENGTH.
 * UStruct writes a ScriptSize, but that is the size the script occupies in memory; on
 * disk UE1 serializes it token by token and the two differ. Skipping ScriptSize bytes
 * happens to work for a class with no script (`ripper`) and lands in the middle of the
 * bytecode for one with any (`UT_Eightball`), where the parse reads garbage and reports
 * a class with no defaults rather than failing.
 *
 * Walking the tokens means writing a disassembler for a bytecode set this project has no
 * other use for. So instead: the property list is the LAST thing in the export and ends
 * with the name "None", which makes it self-delimiting. Scan forward for the first offset
 * whose property stream consumes exactly to the export boundary. A wrong offset almost
 * never does — it runs off the end, hits an unknown type, or stops short.
 */
export function classDefaults(pkg, exp) {
  const { buf } = pkg;
  const end = exp.offset + exp.size;
  const lower = structHeaderEnd(pkg, exp);

  // Landing on the export boundary is necessary but NOT sufficient. A start a few bytes
  // inside the bytecode can resynchronise onto the real list part-way through and end in
  // the same place: RocketMk2 has one that gains "ProcessTouch, Core, Palette" and loses
  // `speed`, and it is both earlier and longer than the truth, so neither position nor
  // length picks the right one.
  //
  // What does pick it is structure. Between the bytecode and the properties sits a fixed
  // UClass tail — UState's masks, ClassFlags, a 16-byte GUID, the dependency and package
  // import lists, ClassWithin and ClassConfigName. So instead of guessing where the
  // properties start, guess where the SCRIPT ends: for each candidate end, parse that
  // tail and see where it delivers us. Only a real script end produces a tail that parses
  // and hands over a property list terminating exactly on the boundary.
  for (let scriptEnd = lower; scriptEnd < end; scriptEnd++) {
    const start = classTailEnd(pkg, scriptEnd, end);
    if (start === null) continue;
    const o = { p: start };
    const props = tryProperties(pkg, o, end);
    if (props === null || o.p !== end) continue;
    return props;
  }
  throw new Error(`${exp.name}: no property list reachable through a valid class tail`);
}

/**
 * Where a class's default properties begin, given where its bytecode ends — or null if
 * no consistent tail starts there.
 */
function classTailEnd(pkg, scriptEnd, end) {
  const { buf, names } = pkg;
  const o = { p: scriptEnd };
  o.p += 8 + 8 + 2 + 4; // UState: ProbeMask, IgnoreMask, LabelTableOffset, StateFlags
  o.p += 4 + 16; // UClass: ClassFlags, ClassGuid
  if (o.p >= end) return null;
  const depCount = compactIndex(buf, o);
  if (depCount < 0 || depCount > 512) return null;
  for (let i = 0; i < depCount; i++) {
    compactIndex(buf, o); // Class
    o.p += 8; // Deep, ScriptTextCRC
    if (o.p >= end) return null;
  }
  const impCount = compactIndex(buf, o);
  if (impCount < 0 || impCount > 512) return null;
  for (let i = 0; i < impCount; i++) {
    compactIndex(buf, o);
    if (o.p >= end) return null;
  }
  if (pkg.version >= 62) {
    compactIndex(buf, o); // ClassWithin
    const cfg = compactIndex(buf, o); // ClassConfigName
    if (cfg < 0 || cfg >= names.length) return null;
  }
  return o.p <= end ? o.p : null;
}

/** Everything before the bytecode, which is fixed-size and safe to step over. */
function structHeaderEnd(pkg, exp) {
  const { buf } = pkg;
  const o = { p: exp.offset };
  const RF_HAS_STACK = 0x02000000;
  if (exp.objectFlags & RF_HAS_STACK) {
    const node = compactIndex(buf, o);
    compactIndex(buf, o);
    o.p += 12;
    if (node !== 0) compactIndex(buf, o);
  }
  compactIndex(buf, o); // UField.SuperField
  compactIndex(buf, o); // UField.Next
  compactIndex(buf, o); // UStruct.ScriptText
  compactIndex(buf, o); // UStruct.Children
  compactIndex(buf, o); // UStruct.FriendlyName
  o.p += 4 + 4 + 4; // Line, TextPos, ScriptSize
  return o.p;
}

/** readProperties, but returning null instead of nonsense when the offset is wrong. */
function tryProperties(pkg, o, end) {
  const { buf, names } = pkg;
  const out = {};
  const refs = {}; // raw object references, as in readProperties
  Object.defineProperty(out, "$refs", { value: refs, enumerable: false });
  let count = 0;
  while (true) {
    if (o.p >= end) return null; // ran off without a terminator
    const before = o.p;
    const nameIdx = compactIndex(buf, o);
    if (nameIdx < 0 || nameIdx >= names.length) return null;
    const name = names[nameIdx];
    if (name === "None") return out;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
    if (o.p >= end) return null;
    o.p = before;
    const one = readOneProperty(pkg, o, end);
    if (one === null) return null;
    assign(out, one.name, one.arrayIndex, one.value);
    if (one.ref !== undefined) refs[one.arrayIndex ? `${one.name}[${one.arrayIndex}]` : one.name] = one.ref;
    if (++count > 512) return null;
  }
}

function assign(out, name, arrayIndex, value) {
  // A property can arrive as a scalar and then as indexed elements, or the other way
  // round. Promote to an array the moment a second element shows up rather than
  // writing through whatever the first one happened to be — assigning into a string
  // is silently ignored in sloppy mode and throws here.
  if (arrayIndex || Array.isArray(out[name])) {
    if (!Array.isArray(out[name])) out[name] = name in out ? [out[name]] : [];
    out[name][arrayIndex] = value;
  } else {
    out[name] = value;
  }
}

function readOneProperty(pkg, o, end) {
  const { buf, names } = pkg;
  const nameIdx = compactIndex(buf, o);
  const name = names[nameIdx];
  const info = buf[o.p++];
  const type = PT[info & 0x0f];
  if (!type) return null;
  const sizeBits = (info >> 4) & 0x07;
  const arrayBit = (info & 0x80) !== 0;

  let structName = null;
  if (type === "struct") {
    const si = compactIndex(buf, o);
    if (si < 0 || si >= names.length) return null;
    structName = names[si];
  }

  let size;
  if (sizeBits === 0) size = 1;
  else if (sizeBits === 1) size = 2;
  else if (sizeBits === 2) size = 4;
  else if (sizeBits === 3) size = 12;
  else if (sizeBits === 4) size = 16;
  else if (sizeBits === 5) size = buf[o.p++];
  else if (sizeBits === 6) { size = buf.readUInt16LE(o.p); o.p += 2; }
  else { size = buf.readInt32LE(o.p); o.p += 4; }

  let arrayIndex = 0;
  if (arrayBit && type !== "bool") {
    const b = buf[o.p++];
    if ((b & 0x80) === 0) arrayIndex = b;
    else if ((b & 0xc0) === 0x80) arrayIndex = ((b & 0x7f) << 8) | buf[o.p++];
    else {
      arrayIndex = ((b & 0x3f) << 24) | (buf[o.p] << 16) | (buf[o.p + 1] << 8) | buf[o.p + 2];
      o.p += 3;
    }
  }

  const start = o.p;
  if (type !== "bool" && (size < 0 || start + size > end)) return null;
  let value;
  let ref;
  switch (type) {
    case "byte": value = buf[o.p]; break;
    case "int": value = buf.readInt32LE(o.p); break;
    case "bool": value = arrayBit; break;
    case "float": value = buf.readFloatLE(o.p); break;
    case "object": case "class": ref = compactIndex(buf, { p: o.p }); value = pkg.resolve(ref); break;
    case "name": { const i = compactIndex(buf, { p: o.p }); if (i < 0 || i >= names.length) return null; value = names[i]; break; }
    case "vector": value = { x: buf.readFloatLE(o.p), y: buf.readFloatLE(o.p + 4), z: buf.readFloatLE(o.p + 8) }; break;
    case "rotator": value = { pitch: buf.readInt32LE(o.p), yaw: buf.readInt32LE(o.p + 4), roll: buf.readInt32LE(o.p + 8) }; break;
    case "str": { const q = { p: o.p }; const len = compactIndex(buf, q); if (len < 0 || q.p + len > end) return null; value = buf.toString("latin1", q.p, q.p + len - 1); break; }
    case "struct": value = { struct: structName, bytes: buf.subarray(o.p, o.p + size) }; break;
    default: value = buf.subarray(o.p, o.p + size);
  }
  if (type !== "bool") o.p = start + size;
  return { name, arrayIndex, value, ref };
}

/**
 * The UnrealScript SOURCE of a class, if the package still carries it.
 *
 * UT99 ships the .uc text inside the .u as a TextBuffer child of each class, which is
 * why nothing here needs a bytecode disassembler: numbers that live in code rather than
 * in defaults — a HurtRadius call's blast radius, say — can simply be read.
 */
export function scriptText(pkg, classExport) {
  const { buf } = pkg;
  const outer = classExport.index + 1;
  const tb = pkg.exports.find(
    (e) => e.package === outer && e.name === "ScriptText" && pkg.classOf(e) === "TextBuffer",
  );
  if (!tb) return null;
  const o = { p: tb.offset };
  // UObject's own tagged properties come first and are terminated by "None".
  readProperties(pkg, o, tb.offset + tb.size);
  o.p += 4; // Pos
  o.p += 4; // Top
  const len = compactIndex(buf, o);
  if (len <= 0) return null;
  return buf.toString("latin1", o.p, o.p + len - 1);
}

/**
 * The WAV inside a USound export.
 *
 * UE1 stores a sound as a format name and a lazy array of bytes, and for format "WAV"
 * those bytes are a complete RIFF file. Rather than model the serialization — which
 * changed shape across engine versions and would need a version guess — this finds the
 * RIFF header inside the export and trusts the file to declare its own length, which is
 * exactly what a RIFF header is for. A wrong answer cannot survive that: the size field
 * has to land back inside the export.
 */
export function soundWav(pkg, name) {
  const { buf } = pkg;
  const exp = pkg.exports.find((e) => e.name === name && pkg.classOf(e) === "Sound");
  if (!exp) return null;
  const start = exp.offset;
  const end = exp.offset + exp.size;
  for (let i = start; i < end - 12; i++) {
    if (buf[i] !== 0x52 || buf[i + 1] !== 0x49 || buf[i + 2] !== 0x46 || buf[i + 3] !== 0x46) continue;
    if (buf.toString("latin1", i + 8, i + 12) !== "WAVE") continue;
    // RIFF size counts everything after the size field itself.
    const total = buf.readUInt32LE(i + 4) + 8;
    if (total < 44 || i + total > end) continue;
    return buf.subarray(i, i + total);
  }
  return null;
}
