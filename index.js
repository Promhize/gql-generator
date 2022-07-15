#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const program = require('commander');
const { Source, buildSchema } = require('graphql');
const del = require('del');

program
  .option('--schemaFilePath [value]', 'path of your graphql schema file')
  .option('--destDirPath [value]', 'dir you want to store the generated queries')
  .option('--depthLimit [value]', 'query depth you want to limit (The default is 100)')
  .option('--assumeValid [value]', 'assume the SDL is valid (The default is false)')
  .option('--ext [value]', 'extension file to use', 'gql')
  .option('-C, --includeDeprecatedFields [value]', 'Flag to include deprecated fields (The default is to exclude)')
  .option('-R, --includeCrossReferences', 'Flag to include fields that have been added to parent queries already (The default is to exclude)')
  .parse(process.argv);

const {
  schemaFilePath,
  destDirPath,
  depthLimit = 100,
  includeDeprecatedFields = false,
  ext: fileExtension,
  assumeValid,
  includeCrossReferences = false,
} = program;

let assume = false;
if (assumeValid === 'true') {
  assume = true;
}

const typeDef = fs.readFileSync(schemaFilePath, 'utf-8');
const source = new Source(typeDef);
const gqlSchema = buildSchema(source, { assumeValidSDL: assume });

del.sync(destDirPath);
path.resolve(destDirPath).split(path.sep).reduce((before, cur) => {
  const pathTmp = path.join(before, cur + path.sep);
  if (!fs.existsSync(pathTmp)) {
    fs.mkdirSync(pathTmp);
  }
  return path.join(before, cur + path.sep);
}, '');
let indexJsExportAll = '';
let clientJs = `
import to from 'await-to-js'
import * as queries from './queries/queries'
import * as mutations from './mutations/mutations'
import {
  AxiosToResponse,
} from '../../types'
import { AxiosError, AxiosResponse } from 'axios'

const axios = require('axios')
const methods: { [key in keyof typeof queries]: typeof queries[key] } &
  { [key in keyof typeof mutations]: typeof mutations[key] } = { ...queries, ...mutations }
type MethodsRecord = typeof methods
type Methods = MethodsRecord[keyof MethodsRecord]
export type ReturnValues = Awaited<ReturnType<Parameters<Methods>[0]['handlers']['2']>>['data']
export type Configs = ReturnType<Methods>
type Endpoints = { commerceAdmin: string; entry: string; workspaceToken: string }

class GatewayClient {
  config: Configs[] = []
  private endpoints: Endpoints
  constructor({endpoints}: {endpoints: Endpoints}) {
    this.endpoints = endpoints
  }
  async fetch() {
    const [err, res]: AxiosToResponse<AxiosResponse<ReturnValues>[]> = await to(
      axios({
        url: \`\${this.endpoints.entry}/fanout\`,
        data: {
          requests: this.config.map(config => ({
            data: {
              variables: (config as any).data,
              query: config.query
            },
            config: {
              endpoint: this.endpoints.commerceAdmin,
            }
          }))
        },
        headers: {
          Authorization: `Bearer ${this.endpoints.workspaceToken}`
        },
        method: 'POST',
        withCredentials: true
      })
    )
    return res
  }`

/**
 * Compile arguments dictionary for a field
 * @param field current field object
 * @param duplicateArgCounts map for deduping argument name collisions
 * @param allArgsDict dictionary of all arguments
 */
const getFieldArgsDict = (
  field,
  duplicateArgCounts,
  allArgsDict = {},
) => field.args.reduce((o, arg) => {
  if (arg.name in duplicateArgCounts) {
    const index = duplicateArgCounts[arg.name] + 1;
    duplicateArgCounts[arg.name] = index;
    o[`${arg.name}${index}`] = arg;
  } else if (allArgsDict[arg.name]) {
    duplicateArgCounts[arg.name] = 1;
    o[`${arg.name}1`] = arg;
  } else {
    o[arg.name] = arg;
  }
  return o;
}, {});

/**
 * Generate variables string
 * @param dict dictionary of arguments
 */
const getArgsToVarsStr = dict => Object.entries(dict)
  .map(([varName, arg]) => `${arg.name}: $${varName}`)
  .join(', ');

/**
 * Generate types string
 * @param dict dictionary of arguments
 */
const getVarsToTypesStr = dict => Object.entries(dict)
  .map(([varName, arg]) => `$${varName}: ${arg.type}`)
  .join(', ');

/**
 * Generate the query for the specified field
 * @param curName name of the current field
 * @param curParentType parent type of the current field
 * @param curParentName parent name of the current field
 * @param argumentsDict dictionary of arguments from all fields
 * @param duplicateArgCounts map for deduping argument name collisions
 * @param crossReferenceKeyList list of the cross reference
 * @param curDepth current depth of field
 * @param fromUnion adds additional depth for unions to avoid empty child
 */
const generateQuery = (
  curName,
  curParentType,
  curParentName,
  argumentsDict = {},
  duplicateArgCounts = {},
  crossReferenceKeyList = [], // [`${curParentName}To${curName}Key`]
  curDepth = 1,
  fromUnion = false,
) => {
  const field = gqlSchema.getType(curParentType).getFields()[curName];
  const curTypeName = field.type.toJSON().replace(/[[\]!]/g, '');
  const curType = gqlSchema.getType(curTypeName);
  let queryStr = '';
  let childQuery = '';

  if (curType.getFields) {
    const crossReferenceKey = `${curParentName}To${curName}Key`;
    if (
      (!includeCrossReferences && crossReferenceKeyList.indexOf(crossReferenceKey) !== -1)
      || (fromUnion ? curDepth - 2 : curDepth) > depthLimit
    ) {
      return '';
    }
    if (!fromUnion) {
      crossReferenceKeyList.push(crossReferenceKey);
    }
    const childKeys = Object.keys(curType.getFields());
    childQuery = childKeys
      .filter((fieldName) => {
        /* Exclude deprecated fields */
        const fieldSchema = gqlSchema.getType(curType).getFields()[fieldName];
        return includeDeprecatedFields || !fieldSchema.deprecationReason;
      })
      .map(cur => generateQuery(cur, curType, curName, argumentsDict, duplicateArgCounts,
        crossReferenceKeyList, curDepth + 1, fromUnion).queryStr)
      .filter(cur => Boolean(cur))
      .join('\n');
  }

  if (!(curType.getFields && !childQuery)) {
    queryStr = `${'    '.repeat(curDepth)}${field.name}`;
    if (field.args.length > 0) {
      const dict = getFieldArgsDict(field, duplicateArgCounts, argumentsDict);
      Object.assign(argumentsDict, dict);
      queryStr += `(${getArgsToVarsStr(dict)})`;
    }
    if (childQuery) {
      queryStr += `{\n${childQuery}\n${'    '.repeat(curDepth)}}`;
    }
  }

  /* Union types */
  if (curType.astNode && curType.astNode.kind === 'UnionTypeDefinition') {
    const types = curType.getTypes();
    if (types && types.length) {
      const indent = `${'    '.repeat(curDepth)}`;
      const fragIndent = `${'    '.repeat(curDepth + 1)}`;
      queryStr += '{\n';

      for (let i = 0, len = types.length; i < len; i++) {
        const valueTypeName = types[i];
        const valueType = gqlSchema.getType(valueTypeName);
        const unionChildQuery = Object.keys(valueType.getFields())
          .map(cur => generateQuery(cur, valueType, curName, argumentsDict, duplicateArgCounts,
            crossReferenceKeyList, curDepth + 2, true).queryStr)
          .filter(cur => Boolean(cur))
          .join('\n');

        /* Exclude empty unions */
        if (unionChildQuery) {
          queryStr += `${fragIndent}... on ${valueTypeName} {\n${unionChildQuery}\n${fragIndent}}\n`;
        }
      }
      queryStr += `${indent}}`;
    }
  }
  return { queryStr, argumentsDict };
};

/**
 * Generate the query for the specified field
 * @param obj one of the root objects(Query, Mutation, Subscription)
 * @param description description of the current object
 */
const generateFile = (obj, description) => {
  let indexJs = '';
  let indexJs2 = '';
  // let operationsJs = '';
  let outputFolderName;
  switch (true) {
    case /Mutation$/.test(description):
      outputFolderName = 'mutations';
      break;
    case /Query$/.test(description):
      outputFolderName = 'queries';
      break;
    case /Subscription$/.test(description):
      outputFolderName = 'subscriptions';
      break;
    default:
      console.log('[gqlg warning]:', 'description is required');
  }
  const writeFolder = path.join(destDirPath, `./${outputFolderName}`);
  try {
    fs.mkdirSync(writeFolder);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  let queryName;
      switch (true) {
        case /Mutation/.test(description):
          queryName = 'mutation';
          break;
        case /Query/.test(description):
          queryName = 'query';
          break;
        case /Subscription/.test(description):
          queryName = 'subscription';
          break;
        default:
          break;
      }
  Object.keys(obj).forEach((type) => {
    const field = gqlSchema.getType(description).getFields()[type];
    /* Only process non-deprecated queries/mutations: */
    if (includeDeprecatedFields || !field.deprecationReason) {
      const queryResult = generateQuery(type, description);
      const varsToTypesStr = getVarsToTypesStr(queryResult.argumentsDict);
      let query = queryResult.queryStr;
      query = `${queryName || description.toLowerCase()} ${type}${varsToTypesStr ? `(${varsToTypesStr})` : ''}{\n${query}\n}`;
      const tsOperation = `${queryName.substring(0,1).toUpperCase()}${queryName.substring(1)}`
      const typeType = `${type.substring(0,1).toUpperCase()}${type.substring(1)}`
      const tsDataType = `${tsOperation}${typeType}Args`
      const hasArguments = obj[type].args.length > 0
      const gqlName = `${type}Gql`
      fs.mkdirSync(path.join(writeFolder, `./${type}`), {recursive: true});
      fs.writeFileSync(path.join(writeFolder, `./${type}/index.ts`), `
import { ${hasArguments ? `${tsDataType}, `: ''}${tsOperation} } from '../../../graphql'
import { Handlers } from '../../../../types'
import ${gqlName} from '../../../operations2/${outputFolderName}/${type}'

export type ${typeType}Result = ${tsOperation}['${type}']
export const ${type} = ({ handlers ${hasArguments ? `, data}: { data: ${tsDataType};` : `}: {`} handlers: Handlers<${typeType}Result>}) => {
  return {
    query: ${gqlName},
    name: ${type},
    handlers,
    ${hasArguments ? `data,` : ''}
  } as const
}`);
      fs.writeFileSync(path.join(writeFolder, `./${type}/${type}.gql`),  `${query}`);
      indexJs += `export * from './${type}'\n`;
      indexJs2 += `export {${type}} from './${type}'\n`;
      // operationsJs += `export {${gqlName}} from './${type}'\n`;
    }
  });
  fs.writeFileSync(path.join(writeFolder, 'index.ts'), indexJs);
  fs.writeFileSync(path.join(writeFolder, `${outputFolderName}.ts`), indexJs2);
  // fs.writeFileSync(path.join(writeFolder, `operations.ts`), operationsJs);
  indexJsExportAll += `export * as ${outputFolderName} from './${outputFolderName}'\n`;

  clientJs = `
  ${clientJs}
  ${Object.keys(obj).map((type) => {
    return `
  public ${type}(args: Parameters<MethodsRecord['${type}']>[0]): this {
    const config = methods.${type}(args)
    return Object.assign(this, {
      config: [...this.config, config]
    })
  }
`}).join('')}
`
  
};

if (gqlSchema.getMutationType()) {
  generateFile(gqlSchema.getMutationType().getFields(), gqlSchema.getMutationType().name);
} else {
  console.log('[gqlg warning]:', 'No mutation type found in your schema');
}

if (gqlSchema.getQueryType()) {
  generateFile(gqlSchema.getQueryType().getFields(), gqlSchema.getQueryType().name);
} else {
  console.log('[gqlg warning]:', 'No query type found in your schema');
}

if (gqlSchema.getSubscriptionType()) {
  generateFile(gqlSchema.getSubscriptionType().getFields(), gqlSchema.getSubscriptionType().name);
} else {
  console.log('[gqlg warning]:', 'No subscription type found in your schema');
}

fs.writeFileSync(path.join(destDirPath, 'index.ts'), indexJsExportAll);
fs.writeFileSync(path.join(destDirPath, 'client.ts'), `${clientJs}
}

export default GatewayClient
`);
