import { Tracer, TracerProvider, Context } from '@opentelemetry/api';
import { Instrumentation, InstrumentationConfig } from '@opentelemetry/instrumentation';
import { MeterProvider } from '@opentelemetry/api-metrics';
import { PrismaClient } from '@prisma/client';
export interface PrismaInstrumentationConfig extends InstrumentationConfig {
    /**
     * Your app's prisma client.  I'd imagine this should be a singleton as I assume the
     * middleware only applies to one instance.  But I haven't tried it.
     */
    prisma: PrismaClient;
    /**
     * When set this db connection info will be used in tracing, otherwise it will look for
     * the DATABASE_URL environment variable
     * @default true
     */
    databaseUrl?: string;
    /**
     * When set to true will trace in the $on query event, attempting to trace the SQL queries
     * as child spans of the Prisma client function call
     * @default true
     */
    useOnQueryEvent?: boolean;
}
export declare class PrismaInstrumentation implements Instrumentation {
    instrumentationName: string;
    instrumentationVersion: string;
    instrumentationDescription?: string;
    _config: PrismaInstrumentationConfig;
    _enabled: boolean;
    _tracer: Tracer;
    _context?: Context;
    constructor(config: PrismaInstrumentationConfig);
    disable(): void;
    enable(): void;
    setTracerProvider(tracerProvider: TracerProvider): void;
    setMeterProvider(meterProvider: MeterProvider): void;
    setConfig(config: PrismaInstrumentationConfig): void;
    getConfig(): InstrumentationConfig;
    init(): void;
    private _setupUseMiddleware;
    private _setupOnQueryEvent;
    private _getDbOpts;
    private _sanitizeQuery;
    private _getQueryFromAction;
    private _getOperationFromQuery;
    private _getOperationFromAction;
}
