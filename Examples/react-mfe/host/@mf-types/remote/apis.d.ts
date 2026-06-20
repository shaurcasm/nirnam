
    export type RemoteKeys = 'remote/Button' | 'remote/ButtonEvent';
    type PackageType<T> = T extends 'remote/ButtonEvent' ? typeof import('remote/ButtonEvent') :T extends 'remote/Button' ? typeof import('remote/Button') :any;