import type { Server } from "node:http";
import { type CanActivate, type INestApplication, RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { ModulesContainer } from "@nestjs/core";

/** Route inventory of a running Nest application, for route-level security checks. */
export type GuardRef = CanActivate | (abstract new (...args: never[]) => CanActivate);

export interface RouteInfo {
  readonly method: string;
  readonly path: string;
  readonly handler: string;
  readonly guards: readonly GuardRef[];
}

function joinPath(...parts: string[]): string {
  const joined = `/${parts.join("/")}`.replace(/\/+/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

function pathsOf(target: object): string[] {
  const value: unknown = Reflect.getMetadata(PATH_METADATA, target);
  const paths: unknown[] = Array.isArray(value) ? value : [value ?? ""];
  return paths.map((path) => {
    if (typeof path !== "string") throw new Error("Unsupported non-string route path metadata");
    return path;
  });
}

function guardsOf(target: object): GuardRef[] {
  const value: unknown = Reflect.getMetadata(GUARDS_METADATA, target);
  return Array.isArray(value) ? (value as GuardRef[]) : [];
}

/** Every handler route of every controller in the running application, from Nest metadata. */
export function metadataRoutes(app: INestApplication): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (controller === null) continue;
      const prototype = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[name];
        if (name === "constructor" || typeof handler !== "function") continue;
        const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
        if (typeof method !== "number") continue;
        for (const base of pathsOf(controller)) {
          for (const sub of pathsOf(handler)) {
            routes.push({
              method: RequestMethod[method] ?? String(method),
              path: joinPath(base, sub),
              handler: `${controller.name}.${name}`,
              guards: [...guardsOf(controller), ...guardsOf(handler)],
            });
          }
        }
      }
    }
  }
  return routes;
}

/** The routes Express actually serves (Express 5 router stack). */
export function registeredRoutes(app: INestApplication<Server>): string[] {
  const express = app.getHttpAdapter().getInstance() as {
    router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
  };
  return express.router.stack.flatMap((layer) =>
    layer.route === undefined
      ? []
      : Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route?.path ?? ""}`),
  );
}
