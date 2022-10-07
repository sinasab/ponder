import { Kind } from "graphql";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { CONFIG } from "@/common/config";
import { logger } from "@/common/logger";
import { formatPrettier } from "@/common/utils";
import { FieldKind, PonderSchema } from "@/core/schema/types";
import { Source, SourceKind } from "@/sources/base";

const gqlScalarToTsType: Record<string, string | undefined> = {
  ID: "string",
  Boolean: "boolean",
  Int: "number",
  String: "string",
  // graph-ts scalar types
  BigInt: "string",
  BigDecimal: "string",
  Bytes: "string",
};

const header = `
/* Autogenerated file. Do not edit manually. */
`;

const generateContextTypes = async (
  sources: Source[],
  schema: PonderSchema
) => {
  const entityNames = schema.entities.map((entity) => entity.name);
  const contractNames = sources
    .filter((source) => source.kind === SourceKind.EVM)
    .map((source) => source.name);

  const imports = `import type { Contract } from "ethers";`;

  const entityModelTypes = schema.entities
    .map((entity) => {
      return `
  export type ${entity.name}Instance = {
    ${entity.fields
      .map((field) => {
        switch (field.kind) {
          case FieldKind.ID: {
            return `${field.name}: string;`;
          }
          case FieldKind.ENUM: {
            return `${field.name}${field.notNull ? "" : "?"}: ${field.enumValues
              .map((val) => `"${val}"`)
              .join(" | ")};`;
          }
          case FieldKind.SCALAR: {
            const scalarTsType = gqlScalarToTsType[field.baseGqlType.name];
            if (!scalarTsType) {
              throw new Error(
                `TypeScript type not found for scalar: ${field.baseGqlType.name}`
              );
            }

            return `${field.name}${field.notNull ? "" : "?"}: ${scalarTsType};`;
          }
          case FieldKind.LIST: {
            // This is trash
            let tsBaseType: string;
            if (
              field.baseGqlType.astNode?.kind === Kind.SCALAR_TYPE_DEFINITION
            ) {
              const scalarTsType = gqlScalarToTsType[field.baseGqlType.name];
              if (!scalarTsType) {
                throw new Error(
                  `TypeScript type not found for scalar: ${field.baseGqlType.name}`
                );
              }
              tsBaseType = scalarTsType;
            } else if (
              field.baseGqlType.astNode?.kind === Kind.ENUM_TYPE_DEFINITION
            ) {
              const enumValues = (field.baseGqlType.astNode?.values || []).map(
                (v) => v.name.value
              );
              tsBaseType = `(${enumValues.map((v) => `"${v}"`).join(" | ")})`;
            } else {
              throw new Error("shit");
            }

            return `${field.name}${field.notNull ? "" : "?"}: ${tsBaseType}[];`;
          }
          case FieldKind.RELATIONSHIP: {
            return `${field.name}: string;`;
          }
        }
      })
      .join("")}
  };

  export type ${entity.name}Model = {
    get: (id: string) => Promise<${entity.name}Instance | null>;
    insert: (obj: ${entity.name}Instance) => Promise<${entity.name}Instance>;
    update: (obj: { id: string } & Partial<${entity.name}Instance>) =>
      Promise<${entity.name}Instance>;
    upsert: (obj: ${entity.name}Instance) => Promise<${entity.name}Instance>;
    delete: (id: string) => Promise<void>;
  };
    `;
    })
    .join("");

  const contractTypes = contractNames
    .map((contractName) => `${contractName}: Contract;`)
    .join("");

  const body = `

  ${entityModelTypes}

  export type Context = {
    entities: {
      ${entityNames
        .map((entityName) => `${entityName}: ${entityName}Model;`)
        .join("")}
    }
    contracts: {
      ${contractTypes}
    }
  }
  `;

  const final = formatPrettier(header + imports + body);

  await writeFile(
    path.join(CONFIG.GENERATED_DIR_PATH, "context.d.ts"),
    final,
    "utf8"
  );

  logger.debug(`Generated context.d.ts file`);
};

export { generateContextTypes };
