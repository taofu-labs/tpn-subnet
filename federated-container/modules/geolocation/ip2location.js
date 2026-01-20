import { IP2Location } from "ip2location-nodejs"
import fs from "fs"
import { normalize } from "path"
import https from "https"
import { cache, log } from "mentie"
import unzipper from "unzipper"
import { datacenter_patterns } from "./helpers.js"

// Configurations
const { CI_MODE } = process.env
const { dirname } = import.meta
const database_folder = normalize( `${ dirname }/../../${ CI_MODE ? '.ip2location_data_local' : 'ip2location_data' }` )
const database_file_name = `IP2LOCATION-LITE-ASN.IPV6.BIN`
const database_file_location = `${ database_folder }/${ database_file_name }`
const database_max_age_ms = 1000 * 60 * 60 * 24 * 2

// Init the IP2Location
const ip2location = new IP2Location()

/**
 * Unzips a .BIN file from a zip archive and extracts it to the specified output path.
 *
 * @param {string} zip_path - The path to the zip file.
 * @param {string} out_path - The path where the .BIN file should be extracted.
 * @returns {Promise<void>} A promise that resolves when the extraction is complete.
 * @throws {Error} If no .BIN file is found in the zip archive.
 */
async function unzip_bin( zip_path, out_path ) {

    // Read the zip file
    const directory = await unzipper.Open.file( zip_path )
    log.info( `Opened the zip file ${ zip_path }, directory contents: `, directory.files.map( file => file.path ) )

    // Find the index of the .BIN file
    const bin_file = directory.files.find( file => file.path.endsWith( '.BIN' ) )
    if( !bin_file ) throw new Error( `No .BIN file found in the zip file ${ zip_path }` )
    
    // Extract the .BIN file to out path
    return new Promise( ( resolve, reject ) => {

        // Create the database folder if it doesn't exist
        if( !fs.existsSync( database_folder ) ) {
            log.info( `Creating the folder ${ database_folder }` )
            fs.mkdirSync( database_folder )
        }

        // Delete the current .bin file
        if( fs.existsSync( out_path ) ) {

            // Remove the file
            log.info( `Removing the file ${ out_path }` )
            fs.unlinkSync( out_path )

        }

        // Create the out stream
        const out_stream = fs.createWriteStream( out_path )
        log.info( `Extracting the file ${ out_path }` )

        // Pipe the file to the out stream 
        log.info( `Piping the file ${ bin_file.path } to the stream` )
        bin_file.stream().pipe( out_stream )

        // On finish, resolve
        out_stream.on( 'finish', () => {
            log.info( `Extracted the file ${ out_path }` )
            out_stream.close()
            resolve()
        } )

        // On error, reject
        out_stream.on( 'error', error => {
            log.error( `Error extracting the file ${ out_path }`, error )
            out_stream.close()
            reject( error )
        } ) 

    } )

}

/**
 * Downloads a file from a given URL and saves it to a specified path.
 * If the URL redirects, it follows the redirect and downloads the file from the new location.
 * If the content type of the response is 'text/html', it rejects with the page content.
 * After downloading, it unzips the file to a specified location.
 *
 * @param {string} url - The URL to download the file from.
 * @param {string} path - The path where the downloaded file will be saved.
 * @returns {Promise<void>} - A promise that resolves when the file is successfully downloaded and unzipped, or rejects with an error.
 */
async function download_url_to_file( url, path ) {

    path = normalize( path )
    const zip_path = `${ path }.zip`

    // Check file context
    const zip_file_exists = fs.existsSync( zip_path )
    const zip_file_timestamp = zip_file_exists ? fs.statSync( zip_path ).mtimeMs : 0
    const zip_outdated = Date.now() - zip_file_timestamp > database_max_age_ms

    // If the zip is not outdated but does exits, extract only
    if( !zip_outdated && zip_file_exists ) {
        log.debug( `The zip file ${ zip_path } is not outdated, extracting the file` )
        return unzip_bin( zip_path, database_file_location )
    }

    // Download the file
    log.debug( `Downloading the file ${ path } from ${ url }` )
    return new Promise( ( resolve, reject ) => {

        // In CI mode do not download
        if( CI_MODE ) {
            log.info( `🤡 Skipping ip2location download in CI mode` )
            return resolve()
        }

        // Get the file
        const download = https.get( url, response => {

            // Log response status
            log.debug( `Response status: ${ response.statusCode }, content type: ${ response.headers[ 'content-type' ] }` )

            // Check if the response is a redirect
            if( response.statusCode >= 300 && response.statusCode < 400 ) {
                const redirect_url = new URL( response.headers.location )
                log.debug( `Redirecting to ${ redirect_url }` )

                // Recursively download the redirect
                return download_url_to_file( redirect_url, path ).then( resolve ).catch( reject )
            }

            // If content type is text/html, make note
            let non_binary_response = false
            if( response.headers[ 'content-type' ].includes( 'text/html' ) ) {
                non_binary_response = true
                log.warn( `The ip2location response is not a binary file, this happens on frequent restarts and can be ignored so long as your ip2location file is up to date` )
            }

            // If the response is non binary, and we already have a zipfile, unzip it
            log.debug( `Zip file exists: ${ zip_file_exists }` )
            if( non_binary_response && zip_file_exists ) {
                log.debug( `The response is not a binary file, but we already have a zip file to extract` )
                return unzip_bin( zip_path, database_file_location ).then( resolve ).catch( reject )
            }
            if( non_binary_response && !zip_file_exists ) {
                log.warn( `The response is not a binary file, and we don't have a zip file to extract` )
                return resolve()
            }
            
            // Create file stream
            log.debug( `Creating the file stream ${ zip_path }` )
            
            // Create the folder recursively if needed
            const folder = path.split( '/' ).slice( 0, -1 ).join( '/' )
            if( !fs.existsSync( folder ) ) {
                log.debug( `Creating the folder ${ folder }` )
                fs.mkdirSync( folder, { recursive: true } )
            }

            // Create the file stream
            const file = fs.createWriteStream( zip_path )

            // Pipe data to file
            response.pipe( file )

            // On file finish, close and resolve
            file.on( 'finish', () => {
                file.close()
                log.debug( `Downloaded the file ${ path }` )

                // Unzip the file
                unzip_bin( zip_path, database_file_location ).then( resolve ).catch( reject )
                
            } )
        } )
        
        // Handle download failure
        download.on( 'error', error => {
            fs.unlink( path, err => {
                if( !err ) return
                log.error( `Error downloading the file ${ path }`, error )
                reject( error )
            } )
            
        } )
    } )

}

/**
 * Updates the IP2Location binary file by downloading the latest version if the current file is older than the maximum allowed age.
 * 
 * @async
 * @function update_ip2location_bin
 * @throws {Error} If the IP2LOCATION_DOWNLOAD_TOKEN environment variable is not set.
 */
export async function update_ip2location_bin() {

    const { IP2LOCATION_DOWNLOAD_TOKEN } = process.env
    if( !IP2LOCATION_DOWNLOAD_TOKEN ) throw new Error( 'IP2LOCATION_DOWNLOAD_TOKEN is not set' )

    // Download the ipv6 file which also contains ipv4 data
    const DATABASE_CODE = `DBASNLITEBINIPV6`
    const download_url = `https://www.ip2location.com/download/?token=${ IP2LOCATION_DOWNLOAD_TOKEN }&file=${ DATABASE_CODE }`

    // Download the file
    log.info( `Downloading the file ${ database_file_location } from ${ download_url }` )
    await download_url_to_file( download_url, database_file_location )

}

/**
 * Checks if an IP address belongs to a datacenter.
 * @param {string} ip_address - The IP address to check.
 * @returns {Promise<boolean|string>} - True if datacenter, false otherwise, or 'ci.ci.ci.ci' in CI mode.
 */
export async function is_data_center( ip_address ) {

    // Check for cached value
    log.insane( `Checking for cached value for IP address ${ ip_address }` )
    const cache_key = `is_dc_${ ip_address }`
    let cached_value = cache( cache_key )
    if( typeof cached_value == 'boolean' ) {
        log.insane( `Returning cached value for IP address ${ ip_address }` )
        return cached_value
    }

    // Check that database file exists
    if( !fs.existsSync( database_file_location ) ) {
        if( CI_MODE ) return 'ci.ci.ci.ci'
        throw new Error( `Database file ${ database_file_location } does not exist` )
    }

    // Check database file metadata
    const { mtimeMs } = fs.statSync( database_file_location )
    const database_age_ms = Date.now() - mtimeMs
    log.insane( `Database file age: ${ database_age_ms } ms` )

    // Get connection type
    ip2location.open( database_file_location )
    const automated_service_name = ip2location.getAS( ip_address )
    ip2location.close()

    // Check against known datacenter providers
    const is_datacenter = datacenter_patterns.some( pattern => pattern.test( automated_service_name ) )
    log.insane( `Retrieved connection type for IP address ${ ip_address } hos ted by ${ automated_service_name }: ${ is_datacenter }` )
    
    cached_value = cache( cache_key, is_datacenter, 5 * 60_000 )
    log.insane( `Returning connection type for IP address ${ ip_address }: `, cached_value )
    return cached_value

}