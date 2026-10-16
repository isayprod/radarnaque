from sqlalchemy import text


async def test_db_fixture_sees_auth_user_table(db):
    await db.execute(text("""insert into auth."user"(id, email) values ('u1', 'a@b.test')"""))
    role = (await db.execute(text("""select role from auth."user" where id = 'u1'"""))).scalar_one()
    assert role == "user"
    await db.rollback()
