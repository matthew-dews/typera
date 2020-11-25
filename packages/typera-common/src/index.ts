import * as Either from 'fp-ts/lib/Either'

import * as Middleware from './middleware'
import * as Parser from './parser'
import * as Response from './response'
import * as URL from './url'

export { Middleware, Parser, Response, URL }

// A request handler takes a request and produces a response

export type RequestHandler<Request, Response> = (
  request: Request
) => Response | Promise<Response>

// Create a route from url parser, middleware and a request handler
export type RouteFn<
  Request,
  Middleware extends Array<Middleware.Generic<Request>>,
  OutsideMiddlewareResponse extends Response.Generic = never
> = TypesFromMiddleware<Request, Middleware> extends MiddlewareType<
  infer MiddlewareResult,
  infer MiddlewareResponse
>
  ? RouteFnImpl<
      MiddlewareResult,
      MiddlewareResponse | OutsideMiddlewareResponse
    >
  : never

type RouteFnImpl<
  Request,
  OutsideMiddlewareResponse extends Response.Generic
> = {
  <Path extends string>(method: URL.Method, path: Path): MakeRoute<
    Request,
    Path,
    OutsideMiddlewareResponse
  >
  use<Middleware extends Middleware.Generic<Request>[]>(
    ...middleware: Middleware
  ): RouteFn<Request, Middleware, OutsideMiddlewareResponse>
} & {
  [M in URL.Method]: <Path extends string>(
    path: Path
  ) => MakeRoute<Request, Path, OutsideMiddlewareResponse>
}

export function applyMiddleware<
  Request,
  Middleware extends Middleware.Generic<Request>[]
>(getRouteParams: (req: Request) => {}, outsideMiddleware: Middleware): any {
  const routeFn = (method: URL.Method, path: string) =>
    makeRouteConstructor(getRouteParams, method, path, outsideMiddleware)

  routeFn.use = (...middleware: any[]) =>
    applyMiddleware(getRouteParams, [...outsideMiddleware, ...middleware])

  routeFn.get = (path: string) => routeFn('get', path)
  routeFn.post = (path: string) => routeFn('post', path)
  routeFn.put = (path: string) => routeFn('put', path)
  routeFn.delete = (path: string) => routeFn('delete', path)
  routeFn.head = (path: string) => routeFn('head', path)
  routeFn.options = (path: string) => routeFn('options', path)
  routeFn.patch = (path: string) => routeFn('patch', path)
  routeFn.all = (path: string) => routeFn('all', path)

  return routeFn as any
}

function makeRouteConstructor<Request>(
  getRouteParams: (req: Request) => {},
  method: URL.Method,
  path: string,
  middleware: any[]
) {
  const urlParser = URL.url(method, path)

  const routeConstructor = (...nextMiddleware: any[]) =>
    route(getRouteParams, urlParser, [...middleware, ...nextMiddleware])

  routeConstructor.use = (...nextMiddleware: any[]) =>
    makeRouteConstructor(getRouteParams, method, path, [
      ...middleware,
      ...nextMiddleware,
    ])

  routeConstructor.handler = route(getRouteParams, urlParser, middleware)

  return routeConstructor
}

export type Route<Response extends Response.Generic> = {
  method: URL.Method
  urlPattern: string
  routeHandler: (req: unknown) => Promise<Response>
}

export function route<
  RequestBase,
  URLCaptures,
  Middleware extends Middleware.Generic<RequestBase>[]
>(
  getRouteParams: (req: RequestBase) => {},
  urlParser: URL.URLParser<URLCaptures>,
  middleware: Middleware
): any {
  return ((handler: (req: any) => any) => ({
    method: urlParser.method,
    urlPattern: urlParser.urlPattern,
    routeHandler: async (requestBase: RequestBase) => {
      const routeParams = urlParser.parse(getRouteParams(requestBase))
      if (Either.isLeft(routeParams)) return routeParams.left

      const middlewareOutput = await runMiddleware(requestBase, middleware)
      if (Either.isLeft(middlewareOutput)) {
        // Finalizers have already run in this case
        return middlewareOutput.left
      }

      let response
      try {
        response = await handler({
          ...middlewareOutput.right.request,
          routeParams: routeParams.right,
        })
      } finally {
        await middlewareOutput.right.runFinalizers()
      }
      return response
    },
  })) as any
}

// Helpers

function isMiddlewareResponse<Result, Response>(
  v: Middleware.MiddlewareOutput<Result, Response>
): v is Middleware.MiddlewareResponse<Response> {
  return (
    Object.prototype.hasOwnProperty.call(v, 'response') &&
    !Object.prototype.hasOwnProperty.call(v, 'value')
  )
}

async function runMiddleware<
  RequestBase,
  Middleware extends Middleware.Generic<RequestBase>[]
>(
  requestBase: RequestBase,
  middleware: Middleware
): Promise<
  Either.Either<
    Response.Generic,
    { request: {}; runFinalizers: () => Promise<void> }
  >
> {
  let request = requestBase

  const finalizers: Array<Middleware.MiddlewareFinalizer> = []

  async function runFinalizers() {
    // Run finalizers in the reverse order
    for (const finalizer of [...finalizers].reverse()) {
      try {
        await finalizer()
      } catch (err) {
        // Log and ignore finalizer errors
        console.error('Ignoring an exception from middleware finalizer', err)
      }
    }
  }

  for (const middlewareFunc of middleware) {
    let output
    try {
      output = await middlewareFunc(request)
    } catch (err) {
      await runFinalizers()
      throw err
    }

    if (isMiddlewareResponse(output)) {
      await runFinalizers()
      return Either.left(output.response)
    } else {
      if (output.finalizer !== undefined) {
        finalizers.push(output.finalizer)
      }
      if (output.value !== undefined) {
        request = { ...request, ...output.value }
      }
    }
  }
  return Either.right({ request, runFinalizers })
}

export type MakeRoute<
  Request,
  Path extends string,
  OutsideMiddlewareResponse extends Response.Generic = never
> = URL.PathToCaptures<Path> extends infer URLCaptures
  ? RouteConstructor<URLCaptures, Request, OutsideMiddlewareResponse>
  : never

interface RouteConstructor<
  URLCaptures,
  Request,
  OutsideMiddlewareResponse extends Response.Generic = never
> {
  <Middleware extends Middleware.Generic<Request>[]>(
    ...middleware: Middleware
  ): TypesFromMiddleware<Request, Middleware> extends MiddlewareType<
    infer MiddlewareResult,
    infer MiddlewareResponse
  >
    ? <Response extends Response.Generic>(
        handler: RequestHandler<
          MiddlewareResult & { routeParams: URLCaptures },
          Response
        >
      ) => Route<Response | MiddlewareResponse | OutsideMiddlewareResponse>
    : never
  use<Middleware extends Middleware.Generic<Request>[]>(
    ...middleware: Middleware
  ): TypesFromMiddleware<Request, Middleware> extends MiddlewareType<
    infer MiddlewareResult,
    infer MiddlewareResponse
  >
    ? RouteConstructor<
        URLCaptures,
        Request & MiddlewareResult,
        MiddlewareResponse | OutsideMiddlewareResponse
      >
    : never
  handler<Response extends Response.Generic>(
    fn: RequestHandler<Request & { routeParams: URLCaptures }, Response>
  ): Route<Response | OutsideMiddlewareResponse>
}

export interface MiddlewareType<Result, Response extends Response.Generic> {
  _result: Result
  _response: Response
}

type TypesFromMiddleware<Request, Middleware> = Middleware extends [
  infer First,
  ...infer Rest
]
  ? First extends Middleware.Middleware<Request, infer Result, infer Response>
    ? TypesFromMiddleware<Request, Rest> extends MiddlewareType<
        infer ResultTail,
        infer ResponseTail
      >
      ? MiddlewareType<Result & ResultTail, Response | ResponseTail>
      : never
    : never
  : MiddlewareType<Request, never>
