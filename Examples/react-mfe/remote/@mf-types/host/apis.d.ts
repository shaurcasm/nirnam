
    export type RemoteKeys = 'host/ButtonEventResponse';
    type PackageType<T> = T extends 'host/ButtonEventResponse' ? typeof import('host/ButtonEventResponse') :any;