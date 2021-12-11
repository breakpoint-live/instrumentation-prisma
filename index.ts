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
import { trace, context, SpanKind, SpanStatusCode, Tracer, TracerProvider, Context} from '@opentelemetry/api'
import { Instrumentation, InstrumentationConfig } from '@opentelemetry/instrumentation'
import { SemanticAttributes, NetTransportValues, DbSystemValues } from '@opentelemetry/semantic-conventions'
import { MeterProvider } from '@opentelemetry/api-metrics'
import { parse as pgParse } from 'pg-connection-string'
import { PrismaClient } from '@prisma/client'

export interface PrismaInstrumentationConfig extends InstrumentationConfig {

  /**
   * Your app's prisma client.  I'd imagine this should be a singleton as I assume the
   * middleware only applies to one instance.  But I haven't tried it.
   */
  prisma: PrismaClient

  /**
   * When set this db connection info will be used in tracing, otherwise it will look for
   * the DATABASE_URL environment variable.
   * @default process.env.DATABASE_URL
   */
  databaseUrl?: string

  /**
   * When set to true will trace in the $on query event, attempting to trace the SQL queries
   * as child spans of the Prisma client function call.
   * @default true
   */
  useOnQueryEvent?: boolean
}

const DEFAULT_CONFIG = {
  databaseUrl: process.env.DATABASE_URL,
  useOnQueryEvent: true,
}

export class PrismaInstrumentation implements Instrumentation {

  instrumentationName: string = 'instrumentation-prisma'
  instrumentationVersion: string = '0.0.1'
  instrumentationDescription?: string = "Prisma Postgres instrumentation"

  _config: PrismaInstrumentationConfig
  _enabled: boolean = true
  _tracer: Tracer
 
  _context?: Context

  constructor(config: PrismaInstrumentationConfig) {
    this._config = Object.assign({}, DEFAULT_CONFIG, config);
    this._tracer = trace.getTracer(this.instrumentationName)
    this.init()
  }

  disable() { this._enabled = false }
  enable() { this._enabled = true }
  setTracerProvider(tracerProvider: TracerProvider) {
    this._tracer = tracerProvider.getTracer(this.instrumentationName)
  }
  setMeterProvider(meterProvider: MeterProvider) {
    // Not implemented
  }
  setConfig(config: PrismaInstrumentationConfig): void {
    this._config = Object.assign({}, DEFAULT_CONFIG, config);
  }
  getConfig(): InstrumentationConfig { return this._config }

  init() {
    this._setupUseMiddleware()
    if (this._config.useOnQueryEvent) this._setupOnQueryEvent()
  }

  private _setupUseMiddleware() {
    this._config.prisma.$use(async (params:any, next: (params: any) => any): Promise<any> => {
      if (!this._enabled) return next(params)

      const op = this._getOperationFromAction(params.action, params.args)
      const query = this._getQueryFromAction(params.action, params.args)
      const { dbconn, dbopts } = this._getDbOpts()
      const span = this._tracer.startSpan(`prisma.${params.action}()`, {
        attributes: {
          // Some of these attributes don't map that well with data from what we get in the $use() params.
          // Notably one call at this level may generate a whole bunch of SQL queries so the most useful
          // bits are he Prisma function name and time spent in it as a parent span.
          [SemanticAttributes.DB_SYSTEM]: DbSystemValues.POSTGRESQL,
          [SemanticAttributes.DB_CONNECTION_STRING]: dbconn,
          [SemanticAttributes.DB_USER]: dbopts.user ?? undefined,
          [SemanticAttributes.NET_PEER_NAME]: dbopts.host ?? undefined,
          [SemanticAttributes.NET_PEER_PORT]: dbopts.port ?? undefined,
          [SemanticAttributes.NET_TRANSPORT]: NetTransportValues.IP_TCP,
          [SemanticAttributes.DB_NAME]: dbopts.database ?? undefined,
          [SemanticAttributes.DB_STATEMENT]: query,
          [SemanticAttributes.DB_OPERATION]: op,
          [SemanticAttributes.DB_SQL_TABLE]: params.model, // this is not 100% correct, but useful
        },
        kind: SpanKind.CLIENT,
      })

      // XXX: I'm not sure this will actually work with a lot of requests/queries going on... there
      // is no way to actually correlate the $on('query') events to this 'parent' span. Would be great
      // to be able to set a UUID here and get it in the $on() callback, or just have both callbacks
      // provide a shared unique query ID - if either of those were present I could at least use a slightly
      // less hacky LRU cache to store Contexts
      this._context = trace.setSpan(context.active(), span)

      let result
      try {
        result = await next(params)
      } catch (error: any) {
        span.setAttribute(SemanticAttributes.EXCEPTION_TYPE, error.name)
        span.setAttribute(SemanticAttributes.EXCEPTION_MESSAGE, error.message)
        span.setStatus({ code: SpanStatusCode.ERROR })
        span.end()
        throw error
      }
      span.setStatus({ code: SpanStatusCode.OK })
      span.end()
  
      return result
    })
  }

  private _setupOnQueryEvent() {
    this._config.prisma.$on('query', (e: any) => {
      if (!this._enabled) return
    
      let context = this._context
      const startTime = e.timestamp
      const endTime = new Date(startTime.valueOf() + Number(e.duration)) // This is in ms, so, not all that precise
      var span
      try {
        const op = this._getOperationFromQuery(e.query)
        const { dbconn, dbopts } = this._getDbOpts()
        span = this._tracer.startSpan(`prisma.${op}`, {
          startTime: startTime,
          attributes: {
            [SemanticAttributes.DB_SYSTEM]: DbSystemValues.POSTGRESQL,
            [SemanticAttributes.DB_CONNECTION_STRING]: dbconn,
            [SemanticAttributes.DB_USER]: dbopts.user ?? undefined,
            [SemanticAttributes.NET_PEER_NAME]: dbopts.host ?? undefined,
            [SemanticAttributes.NET_PEER_PORT]: dbopts.port ?? undefined,
            [SemanticAttributes.NET_TRANSPORT]: NetTransportValues.IP_TCP,
            [SemanticAttributes.DB_NAME]: dbopts.database ?? undefined,
            [SemanticAttributes.DB_STATEMENT]: this._sanitizeQuery(e.query),
            [SemanticAttributes.DB_OPERATION]: op,
            //[SemanticAttributes.DB_SQL_TABLE]: // don't reliably know this, per spec not recommended to parse/guess too much
          },
          kind: SpanKind.CLIENT,
          },
          context
        )

      } catch (error) {
        // really shouldn't throw since query has already run
      }
      span?.setStatus({ code: SpanStatusCode.OK })
      span?.end(endTime)
    })

  }

  private _getDbOpts() {
    let dbconn = this._config.databaseUrl
    let dbopts: any = {}
    if (dbconn) {
      dbopts = pgParse(dbconn)
      if (dbopts.password) dbconn = dbconn.replace(dbopts.password, 'xxx')
    }
    return { dbconn, dbopts }
  }
  
  private _sanitizeQuery(query: string|undefined) {
    // TBD, though the prepared statements do a decent job as is
    return query
  }
  
  private _getQueryFromAction(action: any, args: any) {
    if (action == 'queryRaw' || action == 'executeRaw') {
      return this._sanitizeQuery(args?.query)
    }
    return JSON.stringify(args, (k,v) => (/^pass.*|^phone.*|^email.*/i.test(k))? "xxx" : v)
  }
  
  private _getOperationFromQuery(query: string|undefined) {
    return (query?.substr(0, query.indexOf(' ')) || query)?.toUpperCase()
  }
  
  private _getOperationFromAction(action: any, args: any) {
    let op
    let act = action.toLowerCase()
    switch (action) {
      case 'findUnique':
      case 'findMany':
      case 'findFirst':
      case 'aggregate':
      case 'count':
        op = 'SELECT'
        break
      case 'create':
      case 'createMany':
      case 'upsert': // ?
        op = 'INSERT'
        break
      case 'update':
      case 'updateMany':
        op = 'UPDATE'
        break
      case 'delete':
      case 'deleteMany':
        op = 'DELETE'
        break
      case 'queryRaw':
      case 'executeRaw':
        op = this._getOperationFromQuery(args.query)
        break
      default:
        op = action || undefined
    }
    return op
  }
}

