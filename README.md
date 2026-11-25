# uniflow

A small web app for a campus super-app demo: canteen pre-order with QR pickup, announcements, a simulated bus tracker, and student status. Built with plain HTML/CSS/JS on the frontend and Express + SQLite on the backend.

## System Requirements

### Required Software

- **Node.js** 18 or newer
- **npm**
- **Git**
- **Python 3**
- **Make**
- **GCC / G++** (C/C++ compiler, required for native modules if prebuilt binaries are unavailable)

### Install Dependencies

#### openSUSE
```bash
sudo zypper install -y nodejs npm git python3 make gcc-c++
```

#### Ubuntu / Debian
```bash
sudo apt update
sudo apt install -y nodejs npm git python3 make g++
```

#### Arch Linux
```bash
sudo pacman -S nodejs npm git python base-devel
```

## Setup

Clone the repository and enter the project folder:

```bash
git clone https://github.com/Siddharthcu/CAMPUS_ONE.git
cd CAMPUS_ONE
```

Install dependencies:

```bash
npm install
```

Start the server:

```bash
npm start
```


## Demo login credentials

| Role | Email | Password |
| --- | --- | --- |
| Student | `student@college.edu` | `password123` |
| Staff | `staff@college.edu` | `password123` |
| Admin | `admin@college.edu` | `password123` |

Payment is a simulation — no real money is processed.

## Features

- **Canteen:** category tabs, a cart that survives page navigation, stock limits, staff menu management, mock UPI payment, and a signed single-use pickup QR. Unpaid orders release their reserved stock after 15 minutes; paid pickup codes expire after 40 minutes.
- **My Orders:** students can review all their past orders, see item details and statuses, open a paid order's QR again, and cancel an order before pickup (cancelling returns the reserved stock and invalidates the QR). Staff see cancelled orders with their status in the live queue.
- **Pickup scanner:** staff/admin can scan (or manually paste) a QR token, see the student and items, and redeem it once. Replays and expired codes are rejected.
- **Announcements:** read-only for students; staff/admin can post.
- **Bus tracking:** simulated live positions, delays, per-stop scheduled/live times and ETAs (placeholder for a real GPS feed).
- **Student status:** attendance, fee status, and library books due.

## Project layout

```
public/                 Plain HTML/CSS/JS frontend
  shared/auth.js        Token storage, API wrapper, login guard
  canteen/              Menu, checkout/QR, staff scanner, menu manager
  announcements/        Announcement list + posting form
  bus/, student/        Feature pages
server/
  index.js              Express app, static files, error handling
  db.js                 SQLite schema, one-time migrations, demo seed data
  middleware/           Auth, role checks, simple rate limiter
  routes/               One router per feature
kahe.sqlite*            Local demo database (not committed)
```

## Notes

- This is a college demo, not production-ready: tokens are not revocable after logout, the rate limiter is in-memory, and bus data is simulated.
- Assisted by opencode 
- By Bite codez
