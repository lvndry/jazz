# PDF Summary

Use Jazz to read PDF documents and generate comprehensive summaries.

## Example

**Ask:** `"Read the PDF at ~/Documents/bitcoin.pdf and make a summary"`

**Jazz will:**

1. Read the PDF file from the specified path
2. Extract and analyze the content
3. Identify key topics, sections, and main points
4. Generate a comprehensive summary with:
   - Main topics covered
   - Key points and findings
   - Important details or statistics
   - Conclusions or recommendations (if present)

## Setup

Create an agent with file system tools:

```bash
jazz agent create
# Name: pdf-reader
# Tools: File System
```

## Usage

```bash
jazz agent chat pdf-reader
```

Then ask Jazz to read and summarize a PDF. Jazz will:

- Read the PDF file from the specified path
- Extract all text content
- Analyze the structure and content
- Generate a well-organized summary

### Example Output

```bash
$ jazz agent chat pdf-reader

You: Read the PDF at ~/Documents/bitcoin.pdf and make a summary

Agent: [Reading PDF file...]
       ✓ Successfully read ~/Documents/bitcoin.pdf

       [Analyzing content...]
       Document: "Bitcoin: A Peer-to-Peer Electronic Cash System"
       Pages: 9
       Word count: ~4,500

       # Summary

       ## Overview
       This paper introduces Bitcoin, a decentralized digital currency system that enables
       peer-to-peer electronic transactions without requiring a trusted third party.

       ## Key Topics

       ### 1. The Double-Spending Problem
       - Traditional digital cash requires a trusted central authority
       - Bitcoin solves this through cryptographic proof instead of trust

       ### 2. Network Architecture
       - Peer-to-peer network using proof-of-work
       - Transactions are broadcast to all nodes
       - Nodes accept the longest proof-of-work chain as valid

       ### 3. Transaction Processing
       - Transactions are grouped into blocks
       - Blocks are linked through cryptographic hashing
       - Each block contains a hash of the previous block

       ### 4. Proof-of-Work Mechanism
       - Nodes compete to solve computational puzzles
       - First node to solve broadcasts the solution
       - Other nodes verify and accept the new block
       - Difficulty adjusts to maintain ~10 minute block times

       ## Key Findings

       - Eliminates need for financial institutions as intermediaries
       - Transactions are irreversible once confirmed
       - Network is resistant to attacks as long as honest nodes control majority of CPU power
       - Privacy maintained through public keys (pseudonymous, not anonymous)

       ## Technical Details

       - Uses SHA-256 hash function
       - Block structure includes: previous hash, Merkle root, timestamp, nonce
       - Network nodes can join/leave freely
       - Incentive system: transaction fees + block rewards

       ## Conclusions

       The paper proposes a solution to the double-spending problem using cryptographic
       proof and a decentralized network. The system is designed to be secure,
       transparent, and operate without central authority.

       ✓ Summary complete
```

## More Examples

- `"Read ~/Documents/report.pdf and summarize the main findings"`
- `"Analyze ~/Documents/research-paper.pdf and extract key statistics"`
- `"Read ~/Documents/contract.pdf and highlight important clauses"`
- `"Summarize ~/Documents/presentation.pdf focusing on the conclusions"`
- `"Read ~/Documents/manual.pdf and create a quick reference guide"`

## Tips

- Provide the full path to the PDF file
- Jazz can handle PDFs of various sizes, though very large documents may take longer
- The summary will include the most important information from the document
- You can ask for specific aspects to focus on (e.g., "focus on the methodology section")
- Jazz maintains context, so you can ask follow-up questions about the PDF content

## Limitations

- Jazz reads text content from PDFs. Complex layouts, images, or scanned documents may have limited extraction
- Very large PDFs (>100 pages) may require more processing time
- Mathematical formulas or special formatting may not be perfectly preserved
