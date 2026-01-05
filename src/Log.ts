import { Logger, getLogger } from "log4js"

enum Level {
    TRACE = "TRACE",
    DEBUG = "DEBUG",
    INFO = "INFO",
    WARN = "WARN",
    ERROR = "ERROR",
}

export class Log {
    static getLogger<T>(category: string): Log {
        return new Log(category)
    }

    private readonly log: Logger

    constructor(readonly category: string) {
        this.log = getLogger(category)
    }

    isTraceEnabled(): boolean {
        return this.log.isTraceEnabled()
    }

    isDebugEnabled(): boolean {
        return this.log.isDebugEnabled()
    }

    trace(e: string | Error | object): void {
        if (typeof e === "object" && !(e instanceof Error)) {
            this.log.trace(JSON.stringify(e))
        } else {
            this.log.trace(e)
        }
    }

    debug(e: string | Error | object): void {
        if (typeof e === "object" && !(e instanceof Error)) {
            this.log.debug(JSON.stringify(e))
        } else {
            this.log.debug(e)
        }
    }

    info(e: string | Error | object): void {
        if (typeof e === "object" && !(e instanceof Error)) {
            this.log.info(JSON.stringify(e))
        } else {
            this.log.info(e)
        }
    }

    jinfo(obj: object): void {
        this.log.info(JSON.stringify(obj))
    }

    warn(e: string | Error | object): void {
        if (typeof e === "object" && !(e instanceof Error)) {
            this.log.warn(JSON.stringify(e))
        } else {
            this.log.warn(e)
        }
    }

    jwarn(obj: object): void {
        const strObj = JSON.stringify(obj)
        this.log.warn(strObj)
    }

    error(e: string | Error | object): void {
        if (typeof e === "object" && !(e instanceof Error)) {
            this.log.error(JSON.stringify(e))
        } else {
            this.log.error(e)
        }
    }

    jerror(obj: object): void {
        const strObj = JSON.stringify(obj)
        this.log.error(strObj)
    }
}
