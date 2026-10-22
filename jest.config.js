import { createDefaultEsmPreset } from "ts-jest";

const presetConfig = createDefaultEsmPreset();

/** @type {import("jest").Config} **/
export default {
  ...presetConfig,
  testEnvironment: "node",
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1"
  },
  setupFiles:["<rootDir>/jest.setup.ts"],
  // resetDb trunca ~45 tablas: en Docker sobre Windows a veces pasa de los 5 s por defecto
  testTimeout: 20000
};