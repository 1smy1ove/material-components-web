import {Documentalist, TypescriptPlugin} from '@documentalist/compiler';
import * as fs from 'fs';
import * as Handlebars from 'handlebars';
import * as path from 'path';
import * as util from 'util';
const readFile = util.promisify(fs.readFile);

interface ModuleMarkdown {
  methods?: ModuleMethods[];
  events?: ModuleEvents[];
  properties?: ModuleProperties[];
  moduleName: string;
  readmeDirectoryPath: string;
}

interface ModuleDocumentation {
  events: ModuleEvents[];
}

interface ModuleEvents {
  documentation: string;
}

interface ModuleMethods {
  methodSignature: string;
  documentation: string;
}

interface ModuleProperties {
  name: string;
  type: string;
  documentation: string;
}

interface DocumentationContent {
  tag?: string;
  value?: string;
}

const FOUNDATION = 'foundation';
const ADAPTER = 'adapter';
const README_FILE = 'README.md';

class TypeScriptDocumentationGenerator {
  markdownBuffer: {[s: string]: ModuleMarkdown[]};
  docData?: {}; // Documentalist representation of methods/properties/events
  templateFunction: Handlebars.TemplateDelegate<{}>;

  constructor() {
    this.docData = {};
    this.markdownBuffer = {};
    fs.readFile('./scripts/documentation/apiMarkdownTableTemplate.hbs', 'utf8', (error, template) => {
      if (error) {
        console.error(error); // tslint:disable-line
      }
      this.templateFunction = Handlebars.compile(template, {noEscape: true});
    });
  }

  /**
   * Generates JSON from source files TypeScript documentation.
   * This contains all the esmodule classes (ie. foundations, adapters, components) in JSON format.
   * @returns Promise<{}>
   */
  generateJSONFromFiles() {
    return new Promise((resolve) => {
      new Documentalist()
        .use(/\.ts$/, new TypescriptPlugin({
          excludePaths: ['node_modules'],
          includeDeclarations: true,
        }))
        .documentGlobs('packages/**/*') // ← async operation, returns a Promise
        .then((docs) => resolve(docs))
        .catch((error) => console.error(error)); // tslint:disable-line
    });
  }

  /**
   * The main function of this class. Iterates through all modules found in docData (json).
   * This should already be generated from this.generateJSONFromFiles().
   * @param docData json containing documentation from documentalist
   */
  generateDocs(docData) {
    this.docData = docData.typescript;
    Object.keys(this.docData).forEach((module) => {
      console.log(`-- generating docs for ${module}`); // tslint:disable-line
      this.generateDocsForModule(module);
    });

    this.generateMarkdownFileFromBuffer();
  }

  /**
   * Creates documentation for a specified `esmodule`.
   * @param esmodule module name (ie. MDCSelectIconFoundation)
   */
  generateDocsForModule(esmodule: string) {
    const {kind, fileName} = this.docData[esmodule];
    const readmeDirectoryPath = this.getFilePathName(fileName);

    if (kind === 'type alias') {
      // ignore types and interfaces
      return;
    }
    const markdownObject: ModuleMarkdown = {
      events: this.getDocumentationForModule(esmodule).events,
      methods: this.getDocumentationForMethods(esmodule),
      moduleName: esmodule,
      properties: this.getDocumentationProperties(esmodule),
      readmeDirectoryPath,
    };
    this.addToMarkdownBuffer(readmeDirectoryPath, markdownObject);
  }

  /**
   * This is higher level documentation from the class.
   * Currently this should only include events documentation.
   * @returns documentation of the esmodule.
   * @param esmodule module name (ie. MDCSelectIconFoundation)
   */
  getDocumentationForModule(esmodule: string): ModuleDocumentation {
    if (!this.docData
      || !this.docData[esmodule].documentation
      || !this.docData[esmodule].documentation.contents) {
      return {events: []};
    }
    // this only returns event data
    return {
      events: this.getDocumentationForEvents(esmodule),
    };
  }

  /**
   * Iterates through all events documented in the specified `esmodule`.
   * @returns list of events in the esmodule.
   * @param esmodule module name (ie. MDCSelectIconFoundation)
   */
  getDocumentationForEvents(esmodule: string): ModuleEvents[] {
    return (this.docData[esmodule].documentation.contents as DocumentationContent[])
      .filter((content) => content.tag && content.tag === 'events')
      .map((content) => ({documentation: content.value}));
  }

  /**
   * Iterates through all methods of a specified `esmodule`.
   * @returns list of method documentation of the esmodule.
   * @param esmodule module name (ie. MDCSelectIconFoundation)
   */
  getDocumentationForMethods(esmodule: string): ModuleMethods[] {
    if (!this.docData || !this.docData[esmodule].methods) {
      return [];
    }
    return this.docData[esmodule].methods
      .filter((method) => this.shouldIgnoreDocumentationItem(method, {
        hasDocumentation: method.signatures[0].documentation,
      }))
      .map((method) => {
        const {name, signatures} = method;
        const methodSignature = signatures[0].type;
        const documentation = signatures[0].documentation.contentsRaw;
        return {
          documentation: this.cleanComment(documentation),
          methodSignature: `${name}${methodSignature}`,
        };
      });
  }

  /**
   * Iterates through all properties of a specified `esmodule`.
   * @returns list of property documentation of the esmodule.
   * @param esmodule module name (ie. MDCSelectIconFoundation)
   */
  getDocumentationProperties(esmodule: string): ModuleProperties[] {
    if (!this.docData || !this.docData[esmodule].properties) {
      return [];
    }
    return this.docData[esmodule].properties
      .filter((property) => this.shouldIgnoreDocumentationItem(property, {
        hasDocumentation: property.documentation,
      }))
      .map((property) => {
        const {name, type} = property;
        const documentation = this.cleanComment(property.documentation.contentsRaw);
        return {
          documentation,
          name,
          type,
        };
      });
  }

  /**
   * Returns relative file path to ./packages, and closest directory
   * with a README.md file (ie. mdc-textfield/helper-text, mdc-drawer).
   * @param filePath original file path
   */
  private getFilePathName(filePath: string): string {
    const startingIndex = filePath.indexOf('/mdc-') + 1; // +1 is to ignore leading '/'
    const endIndex = filePath.lastIndexOf('/');
    const directoryPath = filePath.substring(startingIndex, endIndex);
    try {
      const relativePathToReadme = path.resolve('packages', directoryPath, README_FILE);
      if (fs.existsSync(relativePathToReadme)) {
        return directoryPath;
      }
      // look one directory level up
      return this.getFilePathName(directoryPath);
    } catch (err) {
      console.error(err); //tslint:disable-line
    }
    return '';
  }

  /**
   * Sets Markdown Documentation into markdownBuffer under the `component` name.
   * @param component Component that the `markdownString` describes.
   * @param moduleMarkdown List of methods and properties with documentation from esmodule source.
   */
  private addToMarkdownBuffer(readmeDirectoryPath: string, moduleMarkdown: ModuleMarkdown) {
    const markdownComponentBuffer = this.markdownBuffer[readmeDirectoryPath];
    if (markdownComponentBuffer) {
      markdownComponentBuffer.push(moduleMarkdown);
    } else {
      this.markdownBuffer[readmeDirectoryPath] = [moduleMarkdown];
    }
  }

  /**
   * Generates Markdown file for each entry in `this.markdownBuffer`,
   * which is populated from `this.generateDocsForModule()`.
   */
  async generateMarkdownFileFromBuffer() {
    for (const readmeDirectoryPath in this.markdownBuffer) {
      /**
       * This currently only has been tested on mdc-drawer.
       * TODO: remove this if condition once all READMEs are generated
       */
      const allowList = [
        'mdc-drawer',
        // 'mdc-textfield',
      ];

      if (allowList.some((allowed) => readmeDirectoryPath.includes(allowed))) {
        const readmeDestinationPath = `./packages/${readmeDirectoryPath}/${README_FILE}`;
        const finalReadmeMarkdown = await this.insertMethodDescriptionTable(readmeDirectoryPath);
        fs.writeFile(readmeDestinationPath, finalReadmeMarkdown, (error) => {
          console.log(`~~ generated ${readmeDestinationPath}`); // tslint:disable-line
          if (error) {
            console.error('error ', error); //tslint:disable-line
          }
        });
      }
    }
  }

  /**
   * Returns a promise, that resolves with the finalized markdown with
   * inserted documentation in markdown table format.
   * @param readmeDirectoryPath directory path to readme file
   * (ie. mdc-textfield/character-counter or mdc-drawer)
   * @return Promise<{string}>
   */
  private insertMethodDescriptionTable(readmeDirectoryPath: string) {
    const readmeMarkdownPath = `./packages/${readmeDirectoryPath}/${README_FILE}`;
    return new Promise(async (resolve) => {
      const readmeMd = await readFile(readmeMarkdownPath, 'utf8');
      const modules = this.markdownBuffer[readmeDirectoryPath]
        .filter((module) => module.methods.length || module.properties.length || module.events.length)
        .sort(this.sortByModuleType);
      const apiMarkdownTable = this.templateFunction({modules});

      const startReplacerToken
        = '<!-- docgen-tsdoc-replacer:start __DO NOT EDIT, This section is automatically generated__ -->';
      const endReplacerToken = '<!-- docgen-tsdoc-replacer:end -->';
      const regexString = `^${startReplacerToken}\\n(.|\\n)*${endReplacerToken}$`;
      const regex = new RegExp(regexString, 'gm');
      const insertedData = readmeMd.replace(
        regex,
        `${startReplacerToken}\n${apiMarkdownTable}\n${endReplacerToken}`,
      );

      resolve(insertedData);
    });
  }

  /** Sorts modules by the following rules:
   * 1. Components
   * 2. Adapters
   * 3. Foundations
   * 4. Alphabetized
   * @param a 1st module of comparison
   * @param b 2nd module of comparison
   */
  private sortByModuleType(a: ModuleMarkdown, b: ModuleMarkdown): number {
    const moduleA = a.moduleName.toLowerCase();
    const moduleB = b.moduleName.toLowerCase();
    if (!moduleA.includes(FOUNDATION) && !moduleA.includes(ADAPTER)) {
      return -1;
    } else if (moduleA.includes(FOUNDATION) && !moduleB.includes(FOUNDATION)) {
      return 1;
    } else if (moduleA.includes(FOUNDATION) && moduleB.includes(FOUNDATION)
      || moduleA.includes(ADAPTER) && moduleB.includes(ADAPTER)) {
      // alphabetize
      return moduleA > moduleB ? 1 : -1;
    }
    return 0;
  }

  /**
   * 
   * @param item Documentalist object representation of a method/event/property
   * @param opts object of different booleans - currently only has `hasDocumentation`
   */
  private shouldIgnoreDocumentationItem(item, opts = {hasDocumentation: true}) {
    // isState ignores cssClasses, defaultAdapter, strings
    const {isProtected, isStatic} = item.flags;
    return !isProtected && !isStatic && opts.hasDocumentation;
  }

  /**
   * Removes new lines from raw comment string
   * @param comment raw comment string
   */
  private cleanComment(comment) {
    const r = new RegExp(/\n/gm);
    return comment.replace(r, ' ');
  }
}

const docGenerator = new TypeScriptDocumentationGenerator();
docGenerator.generateJSONFromFiles()
  .then((json) => docGenerator.generateDocs(json));
