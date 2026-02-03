import { abort_controller, log } from "mentie"
import { get_git_branch_and_hash, get_node_version } from "../system/shell.js"
import { default as semver } from "semver"

/**
 * Scores a node's version by checking if it's equal or higher than the local version.
 * @param {Object} params - The parameters object.
 * @param {string} params.ip - The IP address of the node to score.
 * @param {string} [params.public_url] - The public URL of the node. If not provided, it will be constructed using the IP and port.
 * @param {number} [params.port=3000] - The port number of the node.
 * @param {number} [params.grace_window_hours=24] - The grace window in hours to allow for version updates.
 * @returns {Promise<{ version_valid: boolean, version: string|null, exact_match: boolean }>} An object containing the version validity, version string, and exact match status.
 */
export async function score_node_version( { ip, public_url, port=3000, grace_window_hours=24 } ) {

    try {

        // If no public_url provided, formulate it
        if( !public_url ) public_url = `http://${ ip }:${ port }`

        // If public url invald, error
        try {
            new URL( public_url )
        } catch ( e ) {
            throw new Error( `Invalid public_url provided: ${ public_url }` )
        }

        // Set a grace window for updates
        const patch_grace_steps = 1
        const grace_window_ms = grace_window_hours * 60 * 60 * 1000 // 24 hours

        // Get this node's version info
        const { version: local_version } = await get_node_version()
        const { branch: local_branch, hash: local_hash, last_commit_date: local_last_commit_date } = await get_git_branch_and_hash()
        log.debug( `Scoring node version for IP ${ ip } at ${ public_url } against local version ${ local_version } (branch: ${ local_branch }, hash: ${ local_hash })` )


        // Call the node / endpoint to check the branch, version, hash
        const { fetch_options } = abort_controller( { timeout_ms: 5_000 } )
        const { branch: remote_branch, version: remote_version, hash: remote_hash } = await fetch( public_url, fetch_options ).then( res => res.json() )
        if( !remote_version ) throw new Error( `No version returned from node at ${ public_url }` )

        // Check if the remote semver is higher than local
        const [ local_major, local_minor, local_patch ] = local_version.split( '.' ).map( n => parseInt( n ) )

        // Formulate min semver declaration (X.0.0 releases require exact match)
        let min_semver = local_version
        if( local_patch - patch_grace_steps >= 0 ) min_semver = `${ local_major }.${ local_minor }.${ local_patch - patch_grace_steps }`
        else if( local_minor > 0 ) min_semver = `${ local_major }.${ local_minor - 1 }.0`
        const min_semver_string = `>=${ min_semver }`
        
        // Check for branch and hash match
        const version_match = remote_version == local_version
        const branch_match = remote_branch == local_branch
        const hash_match = remote_hash == local_hash
        const exact_match = branch_match && hash_match && version_match

        // Check for semver match
        let semver_equal_or_within_grace = exact_match
        if( !semver_equal_or_within_grace ) semver_equal_or_within_grace = semver.satisfies( remote_version, min_semver_string )
            

        // Check if we are within 24 hours of the last commit date for grace period
        const within_grace_period = Date.now() - new Date( local_last_commit_date ).getTime() < grace_window_ms
        if( within_grace_period && !semver_equal_or_within_grace ) {
            log.info( `Node ${ ip } is within grace period of last commit date ${ local_last_commit_date }. Allowing version ${ remote_version } to be valid.` )
            semver_equal_or_within_grace = true
        } 

        // Define if valid
        const version_valid = semver_equal_or_within_grace

        log.insane( `Node ${ ip } version scoring details:`, { 
            local_version,
            local_branch,
            local_hash,
            remote_version,
            remote_branch,
            remote_hash,
            min_semver_string,
            semver_equal_or_within_grace,
            exact_match,
            within_grace_period
        } )
        log.debug( `Node ${ ip } version ${ remote_version } is ${ version_valid ? 'valid ✅' : 'invalid ❌' }` )
        return { version_valid, version: remote_version, exact_match }

    } catch ( e ) {
        log.warn( `Error scoring node version for ip ${ ip }: ${ e.message }` )
        return { version_valid: false, version: null }
    }

}