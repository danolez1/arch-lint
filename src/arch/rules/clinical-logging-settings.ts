/** Per-file facts the analysis cannot derive from the source text, decided from layers by the rule wrapper. */
export interface FileScope {
  tenantRoute: boolean;
  imageRoute: boolean;
  imageService: boolean;
  mobileUpload: boolean;
}

export interface RawFileOutputApproval {
  sha256: string;
  calls: ReadonlySet<string>;
}

export interface ScalarSource {
  call: string;
  expression: string;
}

export interface Settings {
  eventNames: ReadonlySet<string>;
  corePackage: string;
  loggerModule: RegExp | null;
  createLoggerName: string;
  redactedWriterName: string;
  coreLoggerFile: string;
  coreLoggerSha256: string;
  coreIndexFile: string;
  coreIndexSpecifier: string;
  loggerFactoryFiles: readonly string[];
  unsafeLoggerModules: ReadonlySet<string>;
  clinicalTextName: RegExp;
  internalDbNames: ReadonlySet<string>;
  envKeyMapperFile: string;
  envKeyMapperFunction: string;
  envChildSpreadFile: string;
  envChildSpreadFunction: string;
  rawEnvAllowlist: ReadonlyMap<
    string,
    ReadonlyMap<string, ReadonlySet<string>>
  >;
  approvedScalarSourceSha256: ReadonlyMap<string, string>;
  approvedRawFileOutputs: ReadonlyMap<string, RawFileOutputApproval>;
  safeScalarSources: ReadonlyMap<string, ScalarSource>;
  operationalScalarFields: ReadonlyMap<string, ReadonlySet<string>>;
}

export const DEFAULT_CLINICAL_TEXT_NAMES: readonly string[] = [
  "accountid",
  "accountnumber",
  "documenttext",
  "driverslicense",
  "extractedtext",
  "healthcardnumber",
  "insuranceid",
  "insurancenumber",
  "licensenumber",
  "medicalrecordnumber",
  "memberid",
  "mrn",
  "ocroutput",
  "ocrtext",
  "passportnumber",
  "patientid",
  "patientname",
  "patientnumber",
  "patientreference",
  "policynumber",
  "rawocrtext",
  "rawtext",
  "socialsecuritynumber",
  "ssn",
  "subscriberid",
  "text",
  "transcript",
];

export const DEFAULT_UNSAFE_LOGGER_MODULES: readonly string[] = [
  "bunyan",
  "pino",
  "winston",
];

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Raw)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStrings(value: unknown, fallback: readonly string[] = []): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((item): item is string => typeof item === "string");
}

function pattern(source: string, name: string): RegExp | null {
  if (source === "") return null;
  try {
    return new RegExp(source);
  } catch {
    throw new Error(
      `Option ${name} is not a valid regular expression: ${source}`
    );
  }
}

function clinicalNamePattern(names: readonly string[]): RegExp {
  const normalised = names
    .map((n) => n.replace(/[^a-z0-9]/gi, "").toLowerCase())
    .filter(Boolean);
  return normalised.length === 0
    ? /(?!)/
    : new RegExp(`^(?:${normalised.join("|")})$`);
}

function nestedSets(value: unknown): Map<string, Map<string, Set<string>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  for (const [file, positions] of Object.entries(asRecord(value))) {
    const inner = new Map<string, Set<string>>();
    for (const [position, keys] of Object.entries(asRecord(positions))) {
      inner.set(position, new Set(asStrings(keys)));
    }
    out.set(file, inner);
  }
  return out;
}

function rawFileOutputs(value: unknown): Map<string, RawFileOutputApproval> {
  const out = new Map<string, RawFileOutputApproval>();
  for (const [file, entry] of Object.entries(asRecord(value))) {
    const record = asRecord(entry);
    out.set(file, {
      sha256: asString(record.sha256),
      calls: new Set(asStrings(record.calls)),
    });
  }
  return out;
}

function scalarSources(value: unknown): Map<string, ScalarSource> {
  const out = new Map<string, ScalarSource>();
  for (const [key, entry] of Object.entries(asRecord(value))) {
    const record = asRecord(entry);
    out.set(key, {
      call: asString(record.call),
      expression: asString(record.expression),
    });
  }
  return out;
}

function stringMap(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, entry] of Object.entries(asRecord(value))) {
    if (typeof entry === "string") out.set(key, entry);
  }
  return out;
}

function setMap(value: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [key, entry] of Object.entries(asRecord(value)))
    out.set(key, new Set(asStrings(entry)));
  return out;
}

export function parseSettings(options: Raw): Settings {
  return {
    eventNames: new Set(asStrings(options.eventNames)),
    corePackage: asString(options.corePackage),
    loggerModule: pattern(
      asString(options.loggerModulePattern),
      "loggerModulePattern"
    ),
    createLoggerName: asString(options.createLoggerExport, "createLogger"),
    redactedWriterName: asString(
      options.redactedWriterExport,
      "writeRedactedLine"
    ),
    coreLoggerFile: asString(options.coreLoggerFile),
    coreLoggerSha256: asString(options.coreLoggerSha256),
    coreIndexFile: asString(options.coreIndexFile),
    coreIndexSpecifier: asString(options.coreIndexSpecifier, "./logger.ts"),
    loggerFactoryFiles: asStrings(options.loggerFactoryFiles),
    unsafeLoggerModules: new Set(
      asStrings(options.unsafeLoggerModules, DEFAULT_UNSAFE_LOGGER_MODULES)
    ),
    clinicalTextName: clinicalNamePattern(
      asStrings(options.clinicalTextNames, DEFAULT_CLINICAL_TEXT_NAMES)
    ),
    internalDbNames: new Set(asStrings(options.internalDbNames)),
    envKeyMapperFile: asString(options.envKeyMapperFile),
    envKeyMapperFunction: asString(options.envKeyMapperFunction),
    envChildSpreadFile: asString(options.envChildSpreadFile),
    envChildSpreadFunction: asString(options.envChildSpreadFunction),
    rawEnvAllowlist: nestedSets(options.rawEnvAllowlist),
    approvedScalarSourceSha256: stringMap(
      options.approvedLogScalarSourceSha256
    ),
    approvedRawFileOutputs: rawFileOutputs(options.approvedRawFileOutputs),
    safeScalarSources: scalarSources(options.safeLogScalarSources),
    operationalScalarFields: setMap(options.operationalScalarFields),
  };
}
