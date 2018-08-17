// Parses the development application at the South Australian City of Whyalla web site and places
// them in a database.
//
// Michael Bone
// 17th August 2018

"use strict";

import * as cheerio from "cheerio";
import * as request from "request-promise-native";
import * as sqlite3 from "sqlite3";
import * as urlparser from "url";
import * as moment from "moment";
import * as pdfjs from "pdfjs-dist";
import * as fs from "fs";

sqlite3.verbose();

const DevelopmentApplicationsUrl = "https://www.whyalla.sa.gov.au/page.aspx?u=1081";
const CommentUrl = "mailto:customer.service@whyalla.sa.gov.au";

declare const global: any;

// All valid suburb names.

let SuburbNames = null;

// Sets up an sqlite database.

async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text, [on_notice_from] text, [on_notice_to] text)");
            resolve(database);
        });
    });
}

// Inserts a row in the database if it does not already exist.

async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or ignore into [data] values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.reason,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate,
            developmentApplication.receivedDate,
            null,
            null
        ], function(error, row) {
            if (error) {
                console.error(error);
                reject(error);
            } else {
                if (this.changes > 0)
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and reason \"${developmentApplication.reason}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and reason \"${developmentApplication.reason}\" because it was already present in the database.`);
                sqlStatement.finalize();  // releases any locks
                resolve(row);
            }
        });
    });
}

// An element (consisting of text and a bounding rectangle) in a PDF document.

interface Element {
    text: string,
    x: number,
    y: number,
    width: number,
    height: number
}

// The direction to search for an adjacent element.

enum Direction {
    Right,
    Down
}

// Calculates the square of the Euclidean distance between two elements in the specified direction.

function calculateDistance(element1: Element, element2: Element, direction: Direction) {
    if (direction === Direction.Right) {
        let point1 = { x: element1.x + element1.width, y: element1.y + element1.height / 2 };
        let point2 = { x: element2.x, y: element2.y + element2.height / 2 };
        if (point2.x < point1.x - element1.width / 5)  // arbitrary overlap factor of 20%
            return Number.MAX_VALUE;
        return (point2.x - point1.x) * (point2.x - point1.x) + (point2.y - point1.y) * (point2.y - point1.y);
    } else if (direction === Direction.Down) {
        let point1 = { x: element1.x + element1.width / 2, y: element1.y + element1.height };
        let point2 = { x: Math.min(element2.x + element1.width / 2, element2.x + element2.width), y: element2.y };
        if (point2.y < point1.y - element1.height / 2)  // arbitrary overlap factor of 50%
            return Number.MAX_VALUE;
        return (point2.x - point1.x) * (point2.x - point1.x) + (point2.y - point1.y) * (point2.y - point1.y);
    }
    return Number.MAX_VALUE;
}

// Determines whether there is overlap between the two elements in the specified direction.

function isOverlap(element1: Element, element2: Element, direction: Direction) {
    if (direction === Direction.Right)
        return element2.y < element1.y + element1.height && element2.y + element2.height > element1.y;
    else if (direction === Direction.Down)
        return element2.x < element1.x + element1.width && element2.x + element2.width > element1.x;
    return false;
}

// Finds the closest element either right or down from the element with the specified text.

function findClosestElement(elements: Element[], text: string, direction: Direction) {
    text = text.toLowerCase();
    let matchingElement = elements.find(element => element.text.trim().toLowerCase().startsWith(text));
    if (matchingElement === undefined)
        return undefined;

    let closestElement: Element = undefined;
    for (let element of elements)
        if (closestElement === undefined || (isOverlap(matchingElement, element, direction) && calculateDistance(matchingElement, element, direction) < calculateDistance(matchingElement, closestElement, direction)))
            closestElement = element;
    return closestElement;
}

// Reads and parses development application details from the specified PDF.

async function parsePdf(url: string) {
    let developmentApplications = [];

    // Read the PDF.

    let buffer = await request({ url: url, encoding: null });
    await sleep(2000 + getRandom(0, 5) * 1000);

    // Parse the PDF.  Each page has details of a single application.

    const pdf = await pdfjs.getDocument({ data: buffer });

    for (let index = 0; index < pdf.numPages; index++) {
        let page = await pdf.getPage(index + 1);

        // Construct a text element for each item from the parsed PDF information.

        let textContent = await page.getTextContent();
        let viewport = await page.getViewport(1.0);
        let elements: Element[] = textContent.items.map(item => {
            let transform = pdfjs.Util.transform(viewport.transform, item.transform);
            return { text: item.str, x: transform[4], y: transform[5], width: item.width, height: item.height };
        })

        // Find the application number, reason, received date and address in the elements (based
        // on proximity to known text such as "Dev App No").

        let applicationNumberElement = findClosestElement(elements, "Application No", Direction.Right);
        let reasonElement = findClosestElement(elements, "Development Description", Direction.Down);
        let receivedDateElement = findClosestElement(elements, "Application received", Direction.Right);
        let houseNumberElement = findClosestElement(elements, "Property House No", Direction.Right);
        let streetElement = findClosestElement(elements, "Property Street", Direction.Right);
        let suburbElement = findClosestElement(elements, "Property Suburb", Direction.Right);

        let address = "";
        if (houseNumberElement !== undefined)
            address += houseNumberElement.text.trim();
        if (streetElement !== undefined)
            address += ((address === "") ? "" : " ") + streetElement.text.trim();
        if (suburbElement === undefined || suburbElement.text.trim() === "") {
            console.log("Ignoring application because there is no suburb.");
            continue;
        }

        // Attempt to add the state and post code to the suburb.

        let suburbName = SuburbNames[suburbElement.text.trim()];
        if (suburbName === undefined)
            suburbName = suburbElement.text.trim();

        address += ((address === "") ? "" : ", ") + suburbName;
        address = address.trim();

        // Ensure that the development application details are valid.

        if (applicationNumberElement === undefined || applicationNumberElement.text.trim() === "" || address === "") {
            console.log("Ignoring application because there is either no application number or no address.");
            continue;
        }

        let receivedDate = moment.invalid();
        if (receivedDateElement !== undefined)
            receivedDate = moment(receivedDateElement.text.trim(), "D/MM/YYYY", true);  // allows the leading zero of the day to be omitted

        let reason = "NO DESCRIPTION PROVIDED";
        if (reasonElement !== null && reasonElement.text.trim() !== "")
            reason = reasonElement.text.trim();

        let developmentApplication = {
            applicationNumber: applicationNumberElement.text.trim().replace(/\s/g, ""),
            address: address,
            reason: reason,
            informationUrl: url,
            commentUrl: CommentUrl,
            scrapeDate: moment().format("YYYY-MM-DD"),
            receivedDate: receivedDate.isValid() ? receivedDate.format("YYYY-MM-DD") : ""
        }

        developmentApplications.push(developmentApplication);
    }

    return developmentApplications;
}

// Gets a random integer in the specified range: [minimum, maximum).

function getRandom(minimum: number, maximum: number) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}

// Pauses for the specified number of milliseconds.

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Parses the development applications.

async function main() {
    // Ensure that the database exists.

    let database = await initializeDatabase();
    
    // Read the files containing all possible suburb names.

    SuburbNames = {};
    for (let suburb of fs.readFileSync("suburbnames.txt").toString().replace(/\r/g, "").trim().split("\n"))
        SuburbNames[suburb.split(",")[0]] = suburb.split(",")[1];

    // Retrieve the page that contains the links to the PDFs.

    console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);

    let body = await request({ url: DevelopmentApplicationsUrl });
    let $ = cheerio.load(body);
    await sleep(2000 + getRandom(0, 5) * 1000);

    let pdfUrls: string[] = [];
    for (let element of $("td.u6ListTD a[href$='.pdf']").get()) {
        if (/Development Register/g.test(element.attribs.href)) {  // ignores approved application PDFs and just matches lodged application PDFs
            let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href;
            if (!pdfUrls.some(url => url === pdfUrl))  // avoid duplicates
                pdfUrls.push(pdfUrl);
        }
    }

    if (pdfUrls.length === 0) {
        console.log("No PDF URLs were found on the page.");
        return;
    }

    // Select the most recent PDF.  And randomly select one other PDF (avoid processing all PDFs
    // at once because this may use too much memory, resulting in morph.io terminating the current
    // process).

    let selectedPdfUrls: string[] = [];
    selectedPdfUrls.push(pdfUrls.shift());
    if (pdfUrls.length > 0)
        selectedPdfUrls.push(pdfUrls[getRandom(1, pdfUrls.length)]);
    if (getRandom(0, 2) === 0)
        selectedPdfUrls.reverse();

    for (let pdfUrl of selectedPdfUrls) {
        console.log(`Parsing document: ${pdfUrl}`);
        let developmentApplications = await parsePdf(pdfUrl);
        console.log(`Parsed ${developmentApplications.length} development application(s) from document: ${pdfUrl}`);

        // Attempt to avoid reaching 512 MB memory usage (this will otherwise result in the
        // current process being terminated by morph.io).

        if (global.gc)
            global.gc();

        for (let developmentApplication of developmentApplications)
            await insertRow(database, developmentApplication);
    }
}

main().then(() => console.log("Complete.")).catch(error => console.error(error));
