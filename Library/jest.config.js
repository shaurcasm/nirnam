export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['**/?(*.)+(spec|test).ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    'tests/setup\\.ts',
    'src/worker-source\\.ts',   // generated worker string; run for real only in worker-source.test.ts
    'src/worker-entry\\.ts',    // covered through the generated bundle in worker-source.test.ts
    'src/react\\.ts',           // React hooks, requires jsdom + @testing-library/react
    'src/angular\\.ts',         // Angular service, requires Angular test setup
    'src/agents-react\\.ts',    // Agent React hooks, requires jsdom + @testing-library/react
    'src/canvas-react\\.ts',    // Canvas React binding over the tested CanvasHostController; exercised by Examples/canvas
  ],
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90,
    },
  },
};
