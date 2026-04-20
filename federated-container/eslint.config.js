import { eslint_config } from 'airier'
import import_plugin from 'eslint-plugin-import'

// Extend the airier base config with import validation rules
export default [
    ...eslint_config,
    {
        plugins: {
            'import': import_plugin,
        },
        settings: {
            'import/resolver': {
                node: {
                    extensions: [ '.js', '.jsx', '.ts', '.tsx', '.json' ],
                },
            },
        },
        rules: {
            'import/no-unresolved': 'error',
            'import/named': 'error',
            'import/default': 'error',
            'import/namespace': 'error',
            'import/no-duplicates': 'error',
            'import/extensions': [ 'error', 'always', { js: 'always', json: 'always', ts: 'always' } ],
        },
    },
]
