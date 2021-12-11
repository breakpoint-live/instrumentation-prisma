"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaInstrumentation = void 0;
/*
  A really crude opentelemetry instrumentation plugin for Prisma ORM.  Note this is Postgres
  specific, though it would be pretty trivial to adapt to MySql.
  
  A good instrumenter for node would derive from the @opentelemetry/instrumentation Node
  InstrumentationBase class and support patching the instrumented packages functions, etc.
  That is hard to do with Prisma since it has a binary engine executing statements and isn't
  using the pg packages.  So this simple instrumenter uses Prisma's $use() middleware hook
  and the $on() event listener.
  
  A few issues with this approach:
  
  1. $use() only wraps the Prisma high level methods, so you don't get much of an idea of what
     the engine is doing with actual SQL queries.
  2. $on('query') is called after the query completes - probably after the $use() middleware function
     has returned - so the context handling for a child span is pretty weird... it stores the context
     in an intstance
  3. Also, the timestamp and duration of the event from $on() is in milliseconds, so it's a bit less
     precise than desired (but that's a bit of a nitpick I guess).
  
  To use it, you can do something like this when setting up your tracing:
  
  import { PrismaInstrumentation } from './instrumentaton-prisma'
  import prisma from './db'
  
   ...
  
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new HttpInstrumentation,
      new ExpressInstrumentation,
      new GraphQLInstrumentation,
      new PrismaInstrumentation({
        prisma,
      })
    ],
  });
*/
const api_1 = require("@opentelemetry/api");
const semantic_conventions_1 = require("@opentelemetry/semantic-conventions");
const pg_connection_string_1 = require("pg-connection-string");
const DEFAULT_CONFIG = {
    databaseUrl: process.env.DATABASE_URL,
    useOnQueryEvent: true,
};
class PrismaInstrumentation {
    constructor(config) {
        this.instrumentationName = 'instrumentation-prisma';
        this.instrumentationVersion = '0.0.1';
        this.instrumentationDescription = "Prisma Postgres instrumentation";
        this._enabled = true;
        this._config = Object.assign({}, DEFAULT_CONFIG, config);
        this._tracer = api_1.trace.getTracer(this.instrumentationName);
        this.init();
    }
    disable() { this._enabled = false; }
    enable() { this._enabled = true; }
    setTracerProvider(tracerProvider) {
        this._tracer = tracerProvider.getTracer(this.instrumentationName);
    }
    setMeterProvider(meterProvider) { }
    setConfig(config) {
        this._config = Object.assign({}, DEFAULT_CONFIG, config);
    }
    getConfig() { return this._config; }
    init() {
        this._setupUseMiddleware();
        if (this._config.useOnQueryEvent)
            this._setupOnQueryEvent();
    }
    _setupUseMiddleware() {
        this._config.prisma.$use(async (params, next) => {
            var _a, _b, _c, _d;
            if (!this._enabled)
                return next(params);
            const op = this._getOperationFromAction(params.action, params.args);
            const query = this._getQueryFromAction(params.action, params.args);
            const { dbconn, dbopts } = this._getDbOpts();
            const span = this._tracer.startSpan(`prisma.${params.action}()`, {
                attributes: {
                    // Some of these attributes don't map that well with data from what we get in the $use() params.
                    // Notably one call at this level may generate a whole bunch of SQL queries so the most useful
                    // bits are he Prisma function name and time spent in it as a parent span.
                    [semantic_conventions_1.SemanticAttributes.DB_SYSTEM]: semantic_conventions_1.DbSystemValues.POSTGRESQL,
                    [semantic_conventions_1.SemanticAttributes.DB_CONNECTION_STRING]: dbconn,
                    [semantic_conventions_1.SemanticAttributes.DB_USER]: (_a = dbopts.user) !== null && _a !== void 0 ? _a : undefined,
                    [semantic_conventions_1.SemanticAttributes.NET_PEER_NAME]: (_b = dbopts.host) !== null && _b !== void 0 ? _b : undefined,
                    [semantic_conventions_1.SemanticAttributes.NET_PEER_PORT]: (_c = dbopts.port) !== null && _c !== void 0 ? _c : undefined,
                    [semantic_conventions_1.SemanticAttributes.NET_TRANSPORT]: semantic_conventions_1.NetTransportValues.IP_TCP,
                    [semantic_conventions_1.SemanticAttributes.DB_NAME]: (_d = dbopts.database) !== null && _d !== void 0 ? _d : undefined,
                    [semantic_conventions_1.SemanticAttributes.DB_STATEMENT]: query,
                    [semantic_conventions_1.SemanticAttributes.DB_OPERATION]: op,
                    [semantic_conventions_1.SemanticAttributes.DB_SQL_TABLE]: params.model, // this is not 100% correct, but useful
                },
                kind: api_1.SpanKind.CLIENT,
            });
            // XXX: I'm not sure this will actually work with a lot of requests/queries going on... there
            // is no way to actually correlate the $on('query') events to this 'parent' span. Would be great
            // to be able to set a UUID here and get it in the $on() callback, or just have both callbacks
            // provide a shared unique query ID - if either of those were present I could at least use a slightly
            // less hacky LRU cache to store Contexts
            this._context = api_1.trace.setSpan(api_1.context.active(), span);
            let result;
            try {
                result = await next(params);
            }
            catch (error) {
                span.setAttribute(semantic_conventions_1.SemanticAttributes.EXCEPTION_TYPE, error.name);
                span.setAttribute(semantic_conventions_1.SemanticAttributes.EXCEPTION_MESSAGE, error.message);
                span.setStatus({ code: api_1.SpanStatusCode.ERROR });
                span.end();
                throw error;
            }
            span.setStatus({ code: api_1.SpanStatusCode.OK });
            span.end();
            return result;
        });
    }
    _setupOnQueryEvent() {
        // @ts-ignore - no idea why it doesn't like 'query' passed as as first arg here, examples do it and it works fine
        this._config.prisma.$on('query', (e) => {
            var _a, _b, _c, _d;
            if (!this._enabled)
                return;
            let context = this._context;
            const startTime = e.timestamp;
            const endTime = new Date(startTime.valueOf() + Number(e.duration)); // This is in ms, so, not all that precise
            console.info(`duration: ${e.duration} endTime: ${endTime}  startTime: ${startTime}  duration: ${endTime.valueOf() - startTime.valueOf()} `);
            var span;
            try {
                const op = this._getOperationFromQuery(e.query);
                const { dbconn, dbopts } = this._getDbOpts();
                span = this._tracer.startSpan(`prisma.${op}`, {
                    startTime: startTime,
                    attributes: {
                        [semantic_conventions_1.SemanticAttributes.DB_SYSTEM]: semantic_conventions_1.DbSystemValues.POSTGRESQL,
                        [semantic_conventions_1.SemanticAttributes.DB_CONNECTION_STRING]: dbconn,
                        [semantic_conventions_1.SemanticAttributes.DB_USER]: (_a = dbopts.user) !== null && _a !== void 0 ? _a : undefined,
                        [semantic_conventions_1.SemanticAttributes.NET_PEER_NAME]: (_b = dbopts.host) !== null && _b !== void 0 ? _b : undefined,
                        [semantic_conventions_1.SemanticAttributes.NET_PEER_PORT]: (_c = dbopts.port) !== null && _c !== void 0 ? _c : undefined,
                        [semantic_conventions_1.SemanticAttributes.NET_TRANSPORT]: semantic_conventions_1.NetTransportValues.IP_TCP,
                        [semantic_conventions_1.SemanticAttributes.DB_NAME]: (_d = dbopts.database) !== null && _d !== void 0 ? _d : undefined,
                        [semantic_conventions_1.SemanticAttributes.DB_STATEMENT]: this._sanitizeQuery(e.query),
                        [semantic_conventions_1.SemanticAttributes.DB_OPERATION]: op,
                        //[SemanticAttributes.DB_SQL_TABLE]: // don't reliably know this, per spec not recommended to parse/guess too much
                    },
                    kind: api_1.SpanKind.CLIENT,
                }, context);
            }
            catch (error) {
                // really shouldn't throw since query has already run
            }
            span === null || span === void 0 ? void 0 : span.setStatus({ code: api_1.SpanStatusCode.OK });
            span === null || span === void 0 ? void 0 : span.end(endTime);
        });
    }
    _getDbOpts() {
        let dbconn = this._config.databaseUrl;
        let dbopts = {};
        if (dbconn) {
            dbopts = (0, pg_connection_string_1.parse)(dbconn);
            if (dbopts.password)
                dbconn = dbconn.replace(dbopts.password, 'xxx');
        }
        return { dbconn, dbopts };
    }
    _sanitizeQuery(query) {
        // TBD, though the prepared statements do a decent job as is
        return query;
    }
    _getQueryFromAction(action, args) {
        if (action == 'queryRaw' || action == 'executeRaw') {
            return this._sanitizeQuery(args === null || args === void 0 ? void 0 : args.query);
        }
        return JSON.stringify(args, (k, v) => (/^pass.*|^phone.*|^email.*/i.test(k)) ? "xxx" : v);
    }
    _getOperationFromQuery(query) {
        var _a;
        return (_a = ((query === null || query === void 0 ? void 0 : query.substr(0, query.indexOf(' '))) || query)) === null || _a === void 0 ? void 0 : _a.toUpperCase();
    }
    _getOperationFromAction(action, args) {
        let op;
        let act = action.toLowerCase();
        switch (action) {
            case 'findUnique':
            case 'findMany':
            case 'findFirst':
            case 'aggregate':
            case 'count':
                op = 'SELECT';
                break;
            case 'create':
            case 'createMany':
            case 'upsert': // ?
                op = 'INSERT';
                break;
            case 'update':
            case 'updateMany':
                op = 'UPDATE';
                break;
            case 'delete':
            case 'deleteMany':
                op = 'DELETE';
                break;
            case 'queryRaw':
            case 'executeRaw':
                op = this._getOperationFromQuery(args.query);
                break;
            default:
                op = action || undefined;
        }
        return op;
    }
}
exports.PrismaInstrumentation = PrismaInstrumentation;
//# sourceMappingURL=index.js.map